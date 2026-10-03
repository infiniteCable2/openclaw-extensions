from __future__ import annotations

from pathlib import Path

from openclaw_accelerator.client import BrokerError
from openclaw_accelerator.policy_keeper import AcceleratorPolicyKeeper


class FakeLease:
    def __init__(self) -> None:
        self.unload_requested = True
        self.expires_at_epoch = 120.0
        self.policy_valid_until_epoch = 60.0
        self.released = False
        self.renewals = 0

    def renew(self) -> float:
        self.renewals += 1
        self.unload_requested = False
        self.expires_at_epoch = 150.0
        self.policy_valid_until_epoch = 90.0
        return self.expires_at_epoch

    def release(self) -> None:
        self.released = True


class FakeClient:
    def __init__(self, lease: FakeLease) -> None:
        self.lease = lease
        self.fail = False

    def subscribe_policy(self, *_args: object, **_kwargs: object) -> FakeLease:
        if self.fail:
            raise BrokerError("broker_unavailable", retryable=True)
        return self.lease


def test_policy_keeper_renews_wish_and_fails_closed_when_expired() -> None:
    clock = [10.0]
    lease = FakeLease()
    keeper = AcceleratorPolicyKeeper(
        accelerator_id="gpu0", consumer="stt", socket_path=Path("/unused"),
        client=FakeClient(lease),  # type: ignore[arg-type]
        epoch=lambda: clock[0],
    )
    keeper._refresh()
    assert keeper.unload_requested() is True
    keeper._refresh()
    assert lease.renewals == 1
    assert keeper.unload_requested() is False
    clock[0] = 90.0
    assert keeper.unload_requested() is None
    keeper.close()
    assert lease.released is True


def test_policy_keeper_does_not_invent_daytime_wish_when_broker_is_down() -> None:
    lease = FakeLease()
    client = FakeClient(lease)
    client.fail = True
    keeper = AcceleratorPolicyKeeper(
        accelerator_id="gpu0", consumer="tts", socket_path=Path("/unused"),
        client=client,  # type: ignore[arg-type]
        epoch=lambda: 10.0,
    )
    keeper._refresh()
    assert keeper.unload_requested() is None
