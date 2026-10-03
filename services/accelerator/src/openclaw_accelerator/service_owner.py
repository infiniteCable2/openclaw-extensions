from __future__ import annotations

import argparse
import http.client
import http.server
import os
import signal
import socket
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol, Sequence

from .client import AcceleratorClient
from .policy_keeper import AcceleratorPolicyKeeper
from .runner import LeaseSupervisor, RunnerConfig


class PolicySource(Protocol):
    def start(self) -> None: ...
    def unload_requested(self) -> bool | None: ...
    def close(self) -> None: ...


@dataclass(frozen=True)
class ServiceOwnerConfig:
    idle_stop_seconds: float = 120.0
    retry_seconds: float = 10.0
    poll_seconds: float = 0.5

    def validate(self) -> None:
        if not 0 <= self.idle_stop_seconds <= 3600:
            raise ValueError("idle stop interval is invalid")
        if not 1 <= self.retry_seconds <= 300:
            raise ValueError("worker retry interval is invalid")
        if not 0.1 <= self.poll_seconds <= 5:
            raise ValueError("owner poll interval is invalid")


class ServiceOwner:
    """CPU-side service owner; a runner owns the GPU lease only while its worker lives."""

    def __init__(
        self,
        *,
        policy: PolicySource,
        runner_config: RunnerConfig,
        worker_command: Sequence[str],
        broker_timeout_seconds: float,
        config: ServiceOwnerConfig = ServiceOwnerConfig(),
        runner_factory: Callable[[], LeaseSupervisor] = LeaseSupervisor,
        client: AcceleratorClient,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        config.validate()
        runner_config.validate(broker_timeout_seconds=broker_timeout_seconds)
        if not worker_command:
            raise ValueError("worker command is required")
        self.policy = policy
        self.runner_config = runner_config
        self.worker_command = tuple(worker_command)
        self.broker_timeout_seconds = broker_timeout_seconds
        self.config = config
        self.runner_factory = runner_factory
        self.client = client
        self.monotonic = monotonic
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._demands = 0
        self._idle_since: float | None = None
        self._next_start = 0.0
        self._runner: LeaseSupervisor | None = None
        self._runner_thread: threading.Thread | None = None

    def add_demand(self) -> None:
        with self._lock:
            self._demands += 1
            self._idle_since = None
        self._wake.set()

    def remove_demand(self) -> None:
        with self._lock:
            if self._demands <= 0:
                raise RuntimeError("unbalanced demand release")
            self._demands -= 1
        self._wake.set()

    def _run_worker(self, runner: LeaseSupervisor) -> None:
        try:
            runner.run(
                client=self.client,
                config=self.runner_config,
                command=self.worker_command,
                broker_timeout_seconds=self.broker_timeout_seconds,
            )
        finally:
            self._wake.set()

    def reconcile(self) -> None:
        """Reconcile one policy/demand snapshot without starting a second worker."""
        now = self.monotonic()
        policy_wish = self.policy.unload_requested()
        with self._lock:
            demand = self._demands > 0
            desired = demand or policy_wish is False
            thread = self._runner_thread
            alive = thread is not None and thread.is_alive()
            if thread is not None and not alive:
                self._runner_thread = None
                self._runner = None
                self._next_start = now + self.config.retry_seconds
            if desired:
                self._idle_since = None
                if not alive and now >= self._next_start and not self._stop.is_set():
                    runner = self.runner_factory()
                    thread = threading.Thread(
                        target=self._run_worker,
                        args=(runner,),
                        name=f"gpu-{self.runner_config.consumer}",
                        daemon=True,
                    )
                    self._runner = runner
                    self._runner_thread = thread
                    thread.start()
                return
            if self._idle_since is None:
                self._idle_since = now
            if (alive and now - self._idle_since >= self.config.idle_stop_seconds
                    and self._runner is not None):
                self._runner.request_stop(signal.SIGTERM)

    def run(self) -> None:
        try:
            self.policy.start()
            while not self._stop.is_set():
                self.reconcile()
                self._wake.wait(self.config.poll_seconds)
                self._wake.clear()
        finally:
            with self._lock:
                runner = self._runner
                thread = self._runner_thread
            if runner is not None:
                runner.request_stop(signal.SIGTERM)
            try:
                if thread is not None:
                    thread.join(timeout=self.runner_config.shutdown_timeout_seconds * 2 + 5)
                    if thread.is_alive():
                        raise RuntimeError("GPU worker did not stop; refusing clean shutdown")
            finally:
                self.policy.close()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()


class DemandSocket:
    """Local connection lifetime is the OpenClaw demand signal; no remote commands."""

    def __init__(self, path: Path, owner: ServiceOwner) -> None:
        if not path.is_absolute():
            raise ValueError("demand socket path must be absolute")
        self.path = path
        self.owner = owner
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._listener: socket.socket | None = None
        self._slots = threading.BoundedSemaphore(16)

    def _handle(self, connection: socket.socket) -> None:
        added = False
        try:
            self.owner.add_demand()
            added = True
            with connection:
                connection.sendall(b"READY\n")
                connection.settimeout(1.0)
                while not self._stop.is_set():
                    try:
                        if not connection.recv(1):
                            return
                    except socket.timeout:
                        continue
        except OSError:
            pass
        finally:
            if added:
                self.owner.remove_demand()
            self._slots.release()

    def serve(self, *, owner_alive: Callable[[], bool] = lambda: True) -> None:
        if self.path.exists() or self.path.is_symlink():
            raise RuntimeError("demand socket already exists")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            self._listener = listener
            listener.bind(str(self.path))
            os.chmod(self.path, 0o600)
            listener.listen(16)
            listener.settimeout(1.0)
            try:
                while not self._stop.is_set():
                    if not owner_alive():
                        raise RuntimeError("GPU service owner stopped unexpectedly")
                    try:
                        connection, _ = listener.accept()
                    except socket.timeout:
                        continue
                    except OSError:
                        if self._stop.is_set():
                            break
                        raise
                    if not self._slots.acquire(blocking=False):
                        connection.close()
                        continue
                    self._threads = [thread for thread in self._threads if thread.is_alive()]
                    thread = threading.Thread(target=self._handle, args=(connection,), daemon=True)
                    self._threads.append(thread)
                    thread.start()
            finally:
                self._listener = None
                self._stop.set()
                for thread in self._threads:
                    thread.join(timeout=2)
                self.path.unlink(missing_ok=True)

    def stop(self) -> None:
        self._stop.set()
        listener = self._listener
        if listener is not None:
            listener.close()


def owner_main() -> None:
    parser = argparse.ArgumentParser(description="Own one local GPU service across standby periods")
    parser.add_argument("--control-socket", type=Path, required=True)
    parser.add_argument("--broker-socket", type=Path, required=True)
    parser.add_argument("--accelerator-id", required=True)
    parser.add_argument("--consumer", required=True)
    parser.add_argument("--idle-stop-seconds", type=float, default=120)
    parser.add_argument("worker", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    worker = list(args.worker)
    if worker[:1] == ["--"]:
        worker.pop(0)
    if not worker or not Path(worker[0]).is_absolute() or not Path(worker[0]).is_file():
        parser.error("worker executable must be an existing absolute file")
    client = AcceleratorClient(args.broker_socket)
    owner = ServiceOwner(
        policy=AcceleratorPolicyKeeper(
            accelerator_id=args.accelerator_id,
            consumer=args.consumer,
            socket_path=args.broker_socket,
        ),
        runner_config=RunnerConfig(accelerator_id=args.accelerator_id, consumer=args.consumer),
        worker_command=worker,
        broker_timeout_seconds=client.timeout_seconds,
        config=ServiceOwnerConfig(idle_stop_seconds=args.idle_stop_seconds),
        client=client,
    )
    control = DemandSocket(args.control_socket, owner)
    owner_thread = threading.Thread(target=owner.run, name="gpu-service-owner", daemon=True)
    owner_thread.start()
    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, lambda _signum, _frame: control.stop())
    try:
        control.serve(owner_alive=owner_thread.is_alive)
    finally:
        owner.stop()
        owner_thread.join(timeout=owner.runner_config.shutdown_timeout_seconds * 2 + 10)
        if owner_thread.is_alive():
            raise RuntimeError("GPU service owner did not stop")


def demand_main() -> None:
    parser = argparse.ArgumentParser(description="Retain one OpenClaw demand for a local GPU service")
    parser.add_argument("--control-socket", type=Path, required=True)
    parser.add_argument("--health-port", type=int, required=True)
    parser.add_argument("--worker-health-url", required=True)
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.worker_health_url)
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not parsed.path.startswith("/")):
        parser.error("worker health URL must be a loopback HTTP endpoint")
    if not 1 <= args.health_port <= 65535:
        parser.error("health port is invalid")
    try:
        worker_port = parsed.port or 80
    except ValueError:
        parser.error("worker health port is invalid")

    class Readiness(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != "/ready":
                self.send_error(404)
                return
            try:
                worker = http.client.HTTPConnection(parsed.hostname, worker_port, timeout=1.0)
                try:
                    worker.request("GET", parsed.path)
                    ready = worker.getresponse().status == 200
                finally:
                    worker.close()
            except (OSError, http.client.HTTPException):
                ready = False
            self.send_response(200 if ready else 503)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            # Never emit model/provider paths or client identities.
            pass

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(str(args.control_socket))
        if connection.makefile("rb").read(6) != b"READY\n":
            raise SystemExit(75)
        connection.settimeout(None)
        with http.server.ThreadingHTTPServer(("127.0.0.1", args.health_port), Readiness) as server:
            server.daemon_threads = True
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.25}, daemon=True)
            thread.start()
            try:
                while connection.recv(1):
                    pass
            finally:
                server.shutdown()
                thread.join(timeout=2)
    raise SystemExit(75)
