from __future__ import annotations

import signal
import socket
import subprocess
import sys
import threading
import time
import http.client
import http.server
import os

import pytest

from openclaw_accelerator.runner import RunnerConfig
from openclaw_accelerator.service_owner import DemandSocket, ServiceOwner, ServiceOwnerConfig


class FakePolicy:
    def __init__(self, wish: bool | None) -> None:
        self.wish = wish

    def start(self) -> None:
        pass

    def unload_requested(self) -> bool | None:
        return self.wish

    def close(self) -> None:
        pass


class FakeRunner:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.stopped = threading.Event()

    def run(self, **_kwargs: object) -> int:
        self.started.set()
        assert self.stopped.wait(2)
        return 0

    def request_stop(self, signal_number: int) -> None:
        assert signal_number == signal.SIGTERM
        self.stopped.set()


def make_owner(policy: FakePolicy, clock: list[float], runners: list[FakeRunner]) -> ServiceOwner:
    def runner_factory() -> FakeRunner:
        runner = FakeRunner()
        runners.append(runner)
        return runner

    return ServiceOwner(
        policy=policy,
        runner_config=RunnerConfig(accelerator_id="gpu0", consumer="stt"),
        worker_command=["/reviewed/worker"],
        broker_timeout_seconds=60,
        config=ServiceOwnerConfig(idle_stop_seconds=5, retry_seconds=1),
        runner_factory=runner_factory,
        client=object(),  # type: ignore[arg-type]
        monotonic=lambda: clock[0],
    )


def test_policy_keeps_service_warm_without_openclaw_demand() -> None:
    policy = FakePolicy(False)
    clock = [0.0]
    runners: list[FakeRunner] = []
    owner = make_owner(policy, clock, runners)
    owner.reconcile()
    assert runners[0].started.wait(2)
    policy.wish = True
    owner.reconcile()
    clock[0] = 4.9
    owner.reconcile()
    assert not runners[0].stopped.is_set()
    clock[0] = 5.0
    owner.reconcile()
    assert runners[0].stopped.wait(2)
    owner._runner_thread.join(timeout=2)  # type: ignore[union-attr]


def test_openclaw_demand_survives_standby_wish_and_releases_after_idle() -> None:
    policy = FakePolicy(True)
    clock = [0.0]
    runners: list[FakeRunner] = []
    owner = make_owner(policy, clock, runners)
    owner.add_demand()
    owner.reconcile()
    assert runners[0].started.wait(2)
    clock[0] = 100.0
    owner.reconcile()
    assert not runners[0].stopped.is_set()
    owner.remove_demand()
    owner.reconcile()
    clock[0] = 105.0
    owner.reconcile()
    assert runners[0].stopped.wait(2)
    owner._runner_thread.join(timeout=2)  # type: ignore[union-attr]


def test_missing_broker_policy_does_not_preload_model() -> None:
    clock = [0.0]
    runners: list[FakeRunner] = []
    owner = make_owner(FakePolicy(None), clock, runners)
    owner.reconcile()
    assert runners == []


@pytest.mark.skipif(os.name != "posix", reason="Linux service socket integration")
def test_demand_connector_readiness_is_separate_from_warm_worker(tmp_path) -> None:
    worker_ready = threading.Event()

    class Worker(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200 if worker_ready.is_set() else 503)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            pass

    class Owner:
        def __init__(self) -> None:
            self.added = threading.Event()
            self.removed = threading.Event()

        def add_demand(self) -> None:
            self.added.set()

        def remove_demand(self) -> None:
            self.removed.set()

    def health(port: int) -> int | None:
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
            try:
                connection.request("GET", "/ready")
                return connection.getresponse().status
            finally:
                connection.close()
        except OSError:
            return None

    def await_status(port: int, expected: int | None) -> None:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if health(port) == expected:
                return
            time.sleep(0.02)
        assert health(port) == expected

    worker = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Worker)
    worker_thread = threading.Thread(target=worker.serve_forever, daemon=True)
    worker_thread.start()
    control_path = tmp_path / "d.sock"
    owner = Owner()
    control = DemandSocket(control_path, owner)  # type: ignore[arg-type]
    control_thread = threading.Thread(target=control.serve, daemon=True)
    control_thread.start()
    try:
        deadline = time.monotonic() + 3
        while not control_path.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert control_path.exists()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            health_port = reservation.getsockname()[1]
        child = subprocess.Popen(
            [
                sys.executable, "-c",
                "from openclaw_accelerator.service_owner import demand_main; demand_main()",
                "--control-socket", str(control_path),
                "--health-port", str(health_port),
                "--worker-health-url", f"http://127.0.0.1:{worker.server_address[1]}/ready",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            assert owner.added.wait(3)
            await_status(health_port, 503)
            worker_ready.set()
            await_status(health_port, 200)
        finally:
            child.terminate()
            child.wait(timeout=3)
        assert owner.removed.wait(3)
        await_status(health_port, None)
    finally:
        control.stop()
        control_thread.join(timeout=3)
        worker.shutdown()
        worker.server_close()
        worker_thread.join(timeout=3)


@pytest.mark.skipif(os.name != "posix", reason="Linux socket permissions")
def test_demand_socket_rejects_shared_directory(tmp_path) -> None:
    tmp_path.chmod(0o755)
    control = DemandSocket(tmp_path / "d.sock", object())  # type: ignore[arg-type]
    with pytest.raises(RuntimeError, match="private"):
        control.serve()
