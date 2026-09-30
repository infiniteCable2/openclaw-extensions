from __future__ import annotations

import json
from pathlib import Path

from openclaw_accelerator import idle_check


def test_idle_check_returns_broker_decision(monkeypatch, capsys) -> None:
    class Client:
        def __init__(self, socket_path, timeout_seconds) -> None:
            assert socket_path == Path("/run/test.sock")
            assert timeout_seconds == 2.0

        def standby_policy(self, accelerator_id: str) -> tuple[bool, float]:
            assert accelerator_id == "gpu0"
            return False, 4_000_000_000.0

    monkeypatch.setattr(idle_check, "AcceleratorClient", Client)

    assert idle_check.main(["--socket-path", "/run/test.sock", "--accelerator-id", "gpu0"]) == 0
    assert json.loads(capsys.readouterr().out) == {
        "stop": False,
        "validUntilEpoch": 4_000_000_000.0,
    }


def test_idle_check_fails_without_a_broker_decision(monkeypatch, capsys) -> None:
    class Client:
        def __init__(self, socket_path, timeout_seconds) -> None:
            pass

        def standby_policy(self, accelerator_id: str) -> tuple[bool, float]:
            raise OSError("unavailable")

    monkeypatch.setattr(idle_check, "AcceleratorClient", Client)

    assert idle_check.main(["--socket-path", "/run/test.sock", "--accelerator-id", "gpu0"]) == 1
    assert capsys.readouterr().out == ""
