from __future__ import annotations

import signal
import subprocess
from dataclasses import dataclass

import pytest

from openclaw_accelerator.client import BrokerError
from openclaw_accelerator.runner import (
    EXIT_TEMPORARY_FAILURE,
    LeaseSupervisor,
    RunnerConfig,
)


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def monotonic(self) -> float:
        return self.value

    def epoch(self) -> float:
        return 1_000.0 + self.value

    def wait(self, seconds: float) -> None:
        self.value += seconds


@dataclass
class FakeLease:
    clock: FakeClock
    renew_fails: bool = False
    expires_at_epoch: float = 1_090.0
    released: bool = False
    renewals: int = 0

    def renew(self) -> float:
        self.renewals += 1
        if self.renew_fails:
            raise BrokerError("broker_unavailable", retryable=True)
        self.expires_at_epoch = self.clock.epoch() + 90
        return self.expires_at_epoch

    def release(self) -> None:
        self.released = True


class FakeClient:
    def __init__(self, lease: FakeLease | None = None) -> None:
        self.lease = lease
        self.calls = 0

    def acquire(self, *_args, **_kwargs):
        self.calls += 1
        if self.lease is None:
            raise BrokerError("broker_unavailable", retryable=True)
        return self.lease


class FakeProcess:
    def __init__(self, *, exit_after_polls: int | None = None, stoppable: bool = True) -> None:
        self.pid = 1234
        self.exit_after_polls = exit_after_polls
        self.stoppable = stoppable
        self.polls = 0
        self.return_code: int | None = None
        self.signals: list[int] = []
        self.kills = 0

    def poll(self) -> int | None:
        self.polls += 1
        if self.return_code is None and self.exit_after_polls is not None:
            if self.polls >= self.exit_after_polls:
                self.return_code = 0
        return self.return_code

    def send_signal(self, signal_number: int) -> None:
        self.signals.append(signal_number)
        if self.stoppable:
            self.return_code = -signal_number

    def wait(self, timeout: float | None = None) -> int:
        if self.return_code is None:
            raise subprocess.TimeoutExpired("worker", timeout)
        return self.return_code

    def kill(self) -> None:
        self.kills += 1
        if self.stoppable:
            self.return_code = -9


def config() -> RunnerConfig:
    return RunnerConfig(
        accelerator_id="gpu0",
        consumer="openclaw-stt",
        ttl_seconds=90,
        renew_interval_seconds=20,
        renewal_failure_grace_seconds=20,
        shutdown_timeout_seconds=1,
        poll_interval_seconds=1,
    )


def run_supervisor(client: FakeClient, process: FakeProcess, clock: FakeClock) -> int:
    return LeaseSupervisor().run(
        client=client,
        config=config(),
        command=["/srv/openclaw/workers/stt"],
        broker_timeout_seconds=5,
        popen_factory=lambda *_args, **_kwargs: process,
        monotonic=clock.monotonic,
        epoch=clock.epoch,
        wait=clock.wait,
    )


def test_worker_starts_only_after_lease_and_release_follows_exit() -> None:
    clock = FakeClock()
    lease = FakeLease(clock)
    client = FakeClient(lease)
    process = FakeProcess(exit_after_polls=2)
    assert run_supervisor(client, process, clock) == 0
    assert client.calls == 1
    assert lease.released is True
    assert process.signals == []


def test_acquire_failure_never_starts_worker() -> None:
    clock = FakeClock()
    spawned = False

    def spawn(*_args, **_kwargs):
        nonlocal spawned
        spawned = True
        return FakeProcess()

    result = LeaseSupervisor().run(
        client=FakeClient(),
        config=config(),
        command=["/srv/openclaw/workers/stt"],
        broker_timeout_seconds=5,
        popen_factory=spawn,
        monotonic=clock.monotonic,
        epoch=clock.epoch,
        wait=clock.wait,
    )
    assert result == EXIT_TEMPORARY_FAILURE
    assert spawned is False


def test_renewal_failure_stops_worker_before_release() -> None:
    clock = FakeClock()
    lease = FakeLease(clock, renew_fails=True)
    process = FakeProcess()
    assert run_supervisor(FakeClient(lease), process, clock) == EXIT_TEMPORARY_FAILURE
    assert lease.renewals >= 2
    assert process.signals == [signal.SIGTERM]
    assert lease.released is True
    assert clock.epoch() < lease.expires_at_epoch


def test_unproven_worker_stop_keeps_lease_until_ttl_expiry() -> None:
    clock = FakeClock()
    lease = FakeLease(clock, renew_fails=True)
    process = FakeProcess(stoppable=False)
    assert run_supervisor(FakeClient(lease), process, clock) == EXIT_TEMPORARY_FAILURE
    assert process.signals == [signal.SIGTERM]
    assert process.kills == 1
    assert lease.released is False


def test_unsafe_renewal_window_is_rejected() -> None:
    unsafe = RunnerConfig(
        accelerator_id="gpu0",
        consumer="openclaw-stt",
        ttl_seconds=30,
        renew_interval_seconds=10,
        renewal_failure_grace_seconds=10,
    )
    with pytest.raises(ValueError, match="safe renewal window"):
        unsafe.validate(broker_timeout_seconds=10)
