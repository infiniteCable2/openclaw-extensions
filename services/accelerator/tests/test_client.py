from __future__ import annotations

import time
from pathlib import Path

import pytest

from openclaw_accelerator.client import AcceleratorClient, BrokerError


class RecordingClient(AcceleratorClient):
    def __init__(self, response: dict[str, object]) -> None:
        super().__init__((Path.cwd() / "openclaw-accelerator-test.sock").resolve())
        self.response = response
        self.payloads: list[dict[str, object]] = []

    def request(self, payload: dict[str, object]) -> dict[str, object]:
        self.payloads.append(payload)
        return self.response


def test_default_timeout_covers_cold_accelerator_attach() -> None:
    client = AcceleratorClient((Path.cwd() / "openclaw-accelerator-test.sock").resolve())
    assert client.timeout_seconds == 60


def test_acquire_requires_ready_lease_and_builds_bounded_request() -> None:
    client = RecordingClient(
        {
            "version": 1,
            "ok": True,
            "state": "ready",
            "accelerator_id": "gpu0",
            "consumer": "openclaw-stt",
            "lease_id": "x" * 32,
            "expires_at_epoch": time.time() + 90,
            "unload_requested": False,
            "policy_valid_until_epoch": time.time() + 60,
        }
    )
    lease = client.acquire("gpu0", "openclaw-stt", ttl_seconds=90)
    assert lease.lease_id == "x" * 32
    assert lease.unload_requested is False
    assert client.payloads == [
        {
            "version": 1,
            "action": "acquire",
            "accelerator_id": "gpu0",
            "consumer": "openclaw-stt",
            "ttl_sec": 90,
        }
    ]


@pytest.mark.parametrize(
    "response",
    [
        {
            "version": 1,
            "ok": True,
            "state": "attaching",
            "accelerator_id": "gpu0",
            "consumer": "openclaw-stt",
            "lease_id": "x" * 32,
            "expires_at_epoch": time.time() + 90,
        },
        {
            "version": 1,
            "ok": True,
            "state": "ready",
            "accelerator_id": "gpu0",
            "consumer": "openclaw-stt",
            "lease_id": "short",
            "expires_at_epoch": time.time() + 90,
        },
        {
            "version": 1,
            "ok": True,
            "state": "ready",
            "accelerator_id": "gpu0",
            "consumer": "openclaw-stt",
            "lease_id": "x" * 32,
            "expires_at_epoch": 0,
        },
    ],
)
def test_acquire_rejects_unproven_lease(response: dict[str, object]) -> None:
    with pytest.raises(BrokerError, match="broker_response_invalid"):
        RecordingClient(response).acquire("gpu0", "openclaw-stt", ttl_seconds=90)


def test_ids_and_socket_path_fail_closed() -> None:
    with pytest.raises(ValueError, match="absolute"):
        AcceleratorClient(Path("relative.sock"))
    client = RecordingClient({})
    with pytest.raises(ValueError, match="safe id"):
        client.acquire("gpu 0", "openclaw-stt", ttl_seconds=90)


def test_status_policy_requires_current_broker_wish() -> None:
    client = RecordingClient(
        {
            "version": 1,
            "ok": True,
            "accelerator_id": "gpu0",
            "unload_requested": True,
            "policy_valid_until_epoch": time.time() + 60,
        }
    )
    requested, valid_until = client.standby_policy("gpu0")
    assert requested is True
    assert valid_until > time.time()
    assert client.payloads[0]["action"] == "status"
    client.response["unload_requested"] = "true"
    with pytest.raises(BrokerError, match="broker_response_invalid"):
        client.standby_policy("gpu0")


def test_policy_subscription_renews_and_releases_without_ready_state() -> None:
    now = time.time()
    client = RecordingClient({
        "version": 1, "ok": True, "accelerator_id": "gpu0",
        "consumer": "openclaw-stt", "lease_id": "p" * 32,
        "expires_at_epoch": now + 90,
        "unload_requested": True, "policy_valid_until_epoch": now + 50,
    })
    lease = client.subscribe_policy("gpu0", "openclaw-stt", ttl_seconds=90)
    assert lease.unload_requested is True
    assert client.payloads[-1]["action"] == "subscribe_policy"
    client.response = {
        "version": 1, "ok": True, "lease_id": "p" * 32,
        "expires_at_epoch": now + 120,
        "unload_requested": False, "policy_valid_until_epoch": now + 100,
    }
    lease.renew()
    assert lease.unload_requested is False
    assert client.payloads[-1]["action"] == "renew_policy"
    client.response = {"version": 1, "ok": True, "released": True}
    lease.release()
    lease.release()
    assert [payload["action"] for payload in client.payloads] == [
        "subscribe_policy", "renew_policy", "release_policy",
    ]
