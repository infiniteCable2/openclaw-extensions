from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol

from .client import AcceleratorClient, AcceleratorLease, BrokerError

EXIT_TEMPORARY_FAILURE = 75
EXIT_CONFIGURATION_ERROR = 78


class WorkerProcess(Protocol):
    pid: int

    def poll(self) -> int | None: ...

    def wait(self, timeout: float | None = None) -> int: ...

    def send_signal(self, signal_number: int) -> None: ...

    def kill(self) -> None: ...


class LeaseClient(Protocol):
    def acquire(
        self,
        accelerator_id: str,
        consumer: str,
        *,
        ttl_seconds: float,
    ) -> AcceleratorLease: ...


@dataclass(frozen=True)
class RunnerConfig:
    accelerator_id: str
    consumer: str
    ttl_seconds: float = 300.0
    renew_interval_seconds: float = 20.0
    renewal_failure_grace_seconds: float = 20.0
    shutdown_timeout_seconds: float = 20.0
    poll_interval_seconds: float = 0.2

    def validate(self, *, broker_timeout_seconds: float) -> None:
        if not 5 <= self.ttl_seconds <= 86_400:
            raise ValueError("lease TTL is outside its allowed range")
        if not 0 < self.renew_interval_seconds <= self.ttl_seconds / 2:
            raise ValueError("renew interval must be within half the lease TTL")
        if not 0 < self.renewal_failure_grace_seconds <= self.ttl_seconds / 2:
            raise ValueError("renewal failure grace must be within half the lease TTL")
        safety_window = (
            self.renew_interval_seconds
            + self.renewal_failure_grace_seconds
            + broker_timeout_seconds
        )
        if safety_window >= self.ttl_seconds:
            raise ValueError("lease TTL does not leave a safe renewal window")
        if not 0.1 <= self.shutdown_timeout_seconds <= 300:
            raise ValueError("shutdown timeout is outside its allowed range")
        if not 0.02 <= self.poll_interval_seconds <= 5:
            raise ValueError("poll interval is outside its allowed range")


def _exit_code(return_code: int) -> int:
    return 128 + abs(return_code) if return_code < 0 else return_code


def _signal_worker(process: WorkerProcess, signal_number: int) -> None:
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal_number)
        except ProcessLookupError:
            if process.poll() is None:
                raise
    else:
        process.send_signal(signal_number)


def _kill_worker(process: WorkerProcess) -> None:
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            if process.poll() is None:
                raise
    else:
        process.kill()


def _stop_worker(process: WorkerProcess, *, timeout_seconds: float) -> bool:
    if process.poll() is not None:
        return True
    _signal_worker(process, signal.SIGTERM)
    try:
        process.wait(timeout=timeout_seconds)
        return True
    except subprocess.TimeoutExpired:
        pass
    if process.poll() is None:
        _kill_worker(process)
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            return False
    return process.poll() is not None


class LeaseSupervisor:
    def __init__(self) -> None:
        self._stop_lock = threading.Lock()
        self._stop_signal: int | None = None

    def request_stop(self, signal_number: int) -> None:
        with self._stop_lock:
            if self._stop_signal is None:
                self._stop_signal = signal_number

    def _requested_stop(self) -> int | None:
        with self._stop_lock:
            return self._stop_signal

    def run(
        self,
        *,
        client: LeaseClient,
        config: RunnerConfig,
        command: Sequence[str],
        broker_timeout_seconds: float,
        popen_factory: Callable[..., WorkerProcess] = subprocess.Popen,
        monotonic: Callable[[], float] = time.monotonic,
        epoch: Callable[[], float] = time.time,
        wait: Callable[[float], None] = time.sleep,
    ) -> int:
        config.validate(broker_timeout_seconds=broker_timeout_seconds)
        if not command:
            raise ValueError("worker command is required")

        lease: AcceleratorLease | None = None
        process: WorkerProcess | None = None
        shutdown_attempted = False
        try:
            lease = client.acquire(
                config.accelerator_id,
                config.consumer,
                ttl_seconds=config.ttl_seconds,
            )
            if lease.expires_at_epoch - epoch() <= config.renew_interval_seconds:
                raise BrokerError("lease_window_too_short", retryable=True)
            process = popen_factory(list(command), start_new_session=os.name == "posix")
            next_renew = monotonic() + config.renew_interval_seconds
            renewal_failure_started: float | None = None

            while True:
                return_code = process.poll()
                if return_code is not None:
                    return _exit_code(return_code)

                requested_signal = self._requested_stop()
                if requested_signal is not None:
                    shutdown_attempted = True
                    _stop_worker(process, timeout_seconds=config.shutdown_timeout_seconds)
                    return 128 + requested_signal

                now = monotonic()
                if now >= next_renew:
                    renewal_started = now
                    try:
                        lease.renew()
                        if lease.expires_at_epoch - epoch() <= config.renew_interval_seconds:
                            raise BrokerError("lease_window_too_short", retryable=True)
                        renewal_failure_started = None
                        next_renew = monotonic() + config.renew_interval_seconds
                    except BrokerError:
                        after_failure = monotonic()
                        if renewal_failure_started is None:
                            renewal_failure_started = renewal_started
                        grace_exhausted = (
                            after_failure - renewal_failure_started
                            >= config.renewal_failure_grace_seconds
                        )
                        lease_expired = epoch() >= lease.expires_at_epoch
                        if grace_exhausted or lease_expired:
                            shutdown_attempted = True
                            _stop_worker(process, timeout_seconds=config.shutdown_timeout_seconds)
                            return EXIT_TEMPORARY_FAILURE
                        retry_delay = min(1.0, config.renew_interval_seconds / 4)
                        next_renew = after_failure + retry_delay

                wait(config.poll_interval_seconds)
        except BrokerError:
            if process is not None:
                shutdown_attempted = True
                _stop_worker(process, timeout_seconds=config.shutdown_timeout_seconds)
            return EXIT_TEMPORARY_FAILURE
        except OSError:
            if process is not None:
                shutdown_attempted = True
                _stop_worker(process, timeout_seconds=config.shutdown_timeout_seconds)
            return EXIT_CONFIGURATION_ERROR
        finally:
            if process is not None and process.poll() is None and not shutdown_attempted:
                _stop_worker(process, timeout_seconds=config.shutdown_timeout_seconds)
            worker_stopped = process is None or process.poll() is not None
            if lease is not None and worker_stopped:
                try:
                    lease.release()
                except BrokerError:
                    pass
