from __future__ import annotations

import json
import math
import re
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 16_384
MAX_RESPONSE_BYTES = 65_536
_CODE_RE = re.compile(r"[a-z][a-z0-9_]{0,127}")
_ID_RE = re.compile(r"[a-z][a-z0-9_.-]{0,63}")


class BrokerError(RuntimeError):
    def __init__(self, code: str, *, retryable: bool) -> None:
        super().__init__(code)
        self.code = code
        self.retryable = retryable


def _required_number(response: dict[str, Any], name: str) -> float:
    value = response.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BrokerError("broker_response_invalid", retryable=True)
    number = float(value)
    if not math.isfinite(number):
        raise BrokerError("broker_response_invalid", retryable=True)
    return number


@dataclass
class AcceleratorLease:
    client: "AcceleratorClient"
    accelerator_id: str
    lease_id: str
    ttl_seconds: float
    expires_at_epoch: float
    released: bool = False

    def renew(self) -> float:
        response = self.client.request(
            {
                "version": PROTOCOL_VERSION,
                "action": "renew",
                "accelerator_id": self.accelerator_id,
                "lease_id": self.lease_id,
                "ttl_sec": self.ttl_seconds,
            }
        )
        if response.get("lease_id") != self.lease_id:
            raise BrokerError("broker_response_invalid", retryable=True)
        if response.get("state") != "ready":
            raise BrokerError("accelerator_not_ready", retryable=True)
        self.expires_at_epoch = _required_number(response, "expires_at_epoch")
        if self.expires_at_epoch <= time.time():
            raise BrokerError("lease_expired", retryable=False)
        return self.expires_at_epoch

    def release(self) -> None:
        if self.released:
            return
        self.client.request(
            {
                "version": PROTOCOL_VERSION,
                "action": "release",
                "accelerator_id": self.accelerator_id,
                "lease_id": self.lease_id,
            }
        )
        self.released = True


class AcceleratorClient:
    def __init__(self, socket_path: Path, *, timeout_seconds: float = 5.0) -> None:
        path = Path(socket_path)
        if not path.is_absolute():
            raise ValueError("accelerator socket path must be absolute")
        if not 0.1 <= timeout_seconds <= 300:
            raise ValueError("broker timeout is outside its allowed range")
        self.socket_path = path
        self.timeout_seconds = float(timeout_seconds)

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            encoded = (
                json.dumps(payload, separators=(",", ":"), sort_keys=True, allow_nan=False).encode(
                    "utf-8"
                )
                + b"\n"
            )
        except (TypeError, ValueError) as error:
            raise ValueError("accelerator request is not JSON serializable") from error
        if len(encoded) > MAX_REQUEST_BYTES:
            raise ValueError("accelerator request is too large")

        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(self.timeout_seconds)
                connection.connect(str(self.socket_path))
                connection.sendall(encoded)
                raw = connection.makefile("rb").readline(MAX_RESPONSE_BYTES + 1)
        except (OSError, TimeoutError) as error:
            raise BrokerError("broker_unavailable", retryable=True) from error

        if not raw or len(raw) > MAX_RESPONSE_BYTES or not raw.endswith(b"\n"):
            raise BrokerError("broker_response_invalid", retryable=True)
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise BrokerError("broker_response_invalid", retryable=True) from error
        version = response.get("version") if isinstance(response, dict) else None
        if (
            not isinstance(response, dict)
            or isinstance(version, bool)
            or version != PROTOCOL_VERSION
        ):
            raise BrokerError("broker_response_invalid", retryable=True)
        if response.get("ok") is not True:
            raw_code = response.get("error_code")
            code = raw_code if isinstance(raw_code, str) and _CODE_RE.fullmatch(raw_code) else None
            retryable = response.get("retryable") is True
            raise BrokerError(code or "broker_request_failed", retryable=retryable)
        return response

    def acquire(
        self,
        accelerator_id: str,
        consumer: str,
        *,
        ttl_seconds: float,
    ) -> AcceleratorLease:
        if not _ID_RE.fullmatch(accelerator_id) or not _ID_RE.fullmatch(consumer):
            raise ValueError("accelerator and consumer ids must use the safe id format")
        if not 5 <= ttl_seconds <= 86_400:
            raise ValueError("lease TTL is outside its allowed range")
        response = self.request(
            {
                "version": PROTOCOL_VERSION,
                "action": "acquire",
                "accelerator_id": accelerator_id,
                "consumer": consumer,
                "ttl_sec": ttl_seconds,
            }
        )
        lease_id = response.get("lease_id")
        expires_at = _required_number(response, "expires_at_epoch")
        if (
            response.get("state") != "ready"
            or response.get("accelerator_id") != accelerator_id
            or response.get("consumer") != consumer
            or not isinstance(lease_id, str)
            or not 16 <= len(lease_id) <= 512
            or expires_at <= time.time()
        ):
            raise BrokerError("broker_response_invalid", retryable=True)
        return AcceleratorLease(
            client=self,
            accelerator_id=accelerator_id,
            lease_id=lease_id,
            ttl_seconds=float(ttl_seconds),
            expires_at_epoch=expires_at,
        )
