from __future__ import annotations

import signal
import threading

from openclaw_accelerator.runner import RunnerConfig
from openclaw_accelerator.service_owner import ServiceOwner, ServiceOwnerConfig


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
