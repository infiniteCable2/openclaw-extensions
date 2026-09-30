from __future__ import annotations

from pathlib import Path

from openclaw_accelerator.client import BrokerError
from openclaw_accelerator.demand_lease import AcceleratorDemandLease


class Clock:
    now = 0.0

    def __call__(self) -> float:
        return self.now


class Keeper:
    def __init__(self, **_kwargs: object) -> None:
        self.started = False
        self.closed = False
        self.wants_unload = True

    def start(self) -> None:
        self.started = True

    def healthy(self) -> bool:
        return self.started and not self.closed

    def unload_requested(self) -> bool:
        return self.wants_unload

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
    created[0].wants_unload = False
    assert lease.drain_if_idle() is False
    created[0].wants_unload = True
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


def test_demand_lease_unloads_immediately_when_keeper_is_unhealthy() -> None:
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
        idle_release_seconds=120,
        acquire_timeout_seconds=30,
        quiesce=lambda: events.append("quiesce"),
        keeper_factory=factory,
        monotonic=clock,
    )
    lease.acquire()
    lease.release()
    created[0].started = False

    assert lease.drain_if_idle() is True
    assert events == ["quiesce"]


def test_demand_lease_remains_unloaded_when_broker_release_fails() -> None:
    class UnreachableKeeper(Keeper):
        def close(self) -> None:
            super().close()
            raise BrokerError("broker_unavailable", retryable=True)

    events: list[str] = []
    clock = Clock()
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
        keeper_factory=UnreachableKeeper,
        monotonic=clock,
    )
    lease.acquire()
    lease.release()
    clock.now = 1

    assert lease.drain_if_idle() is True
    assert events == ["quiesce"]
    assert lease.ready() is False
