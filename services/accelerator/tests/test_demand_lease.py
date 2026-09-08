from __future__ import annotations

from pathlib import Path

from openclaw_accelerator.demand_lease import AcceleratorDemandLease


class Clock:
    now = 0.0

    def __call__(self) -> float:
        return self.now


class Keeper:
    def __init__(self, **_kwargs: object) -> None:
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def healthy(self) -> bool:
        return self.started and not self.closed

    def close(self) -> None:
        self.closed = True


def test_demand_lease_quiesces_only_after_idle_period() -> None:
    clock = Clock()
    events: list[str] = []
    created: list[Keeper] = []

    def factory(**kwargs: object) -> Keeper:
        keeper = Keeper(**kwargs)
        created.append(keeper)
        return keeper

    lease = AcceleratorDemandLease(
        accelerator_id="gpu0",
        consumer="embedding",
        socket_path=Path("/run/test.sock"),
        ttl_seconds=60,
        renew_interval_seconds=20,
        failure_grace_seconds=20,
        idle_release_seconds=10,
        acquire_timeout_seconds=30,
        quiesce=lambda: events.append("quiesce"),
        keeper_factory=factory,
        monotonic=clock,
    )
    lease.acquire()
    lease.release()
    clock.now = 9
    assert lease.drain_if_idle() is False
    clock.now = 10
    assert lease.drain_if_idle() is True
    assert events == ["quiesce"]
    assert created[0].closed is True


def test_demand_lease_reference_counts_parallel_activity() -> None:
    clock = Clock()
    events: list[str] = []
    lease = AcceleratorDemandLease(
        accelerator_id="gpu0",
        consumer="embedding",
        socket_path=Path("/run/test.sock"),
        ttl_seconds=60,
        renew_interval_seconds=20,
        failure_grace_seconds=20,
        idle_release_seconds=1,
        acquire_timeout_seconds=30,
        quiesce=lambda: events.append("quiesce"),
        keeper_factory=Keeper,
        monotonic=clock,
    )
    lease.acquire()
    lease.acquire()
    lease.release()
    clock.now = 5
    assert lease.drain_if_idle() is False
    lease.release()
    clock.now = 6
    assert lease.drain_if_idle() is True
    assert events == ["quiesce"]
