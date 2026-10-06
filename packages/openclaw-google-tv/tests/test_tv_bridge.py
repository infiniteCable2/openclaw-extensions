"""No-network tests for the exact TV power semantics."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

if importlib.util.find_spec("androidtvremote2") is None:
    # The bridge's transport is replaced in every no-network power test.
    sys.modules["androidtvremote2"] = types.SimpleNamespace(AndroidTVRemote=object)


PATH = Path(__file__).resolve().parents[1] / "runtime" / "tv_bridge.py"
SPEC = importlib.util.spec_from_file_location("tv_bridge", PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class FakeRemote:
    next_power = False
    commands = []

    def __init__(self, *_args, **_kwargs):
        self.is_on = self.next_power
        self.current_app = None

    async def async_connect(self):
        return None

    def send_key_command(self, key):
        self.commands.append(key)
        if key == "POWER":
            self.is_on = not self.is_on

    def disconnect(self):
        pass


class PowerTests(unittest.TestCase):
    def setUp(self):
        FakeRemote.commands = []

    def run_power(self, initial, desired):
        FakeRemote.next_power = initial
        with patch.object(bridge, "AndroidTVRemote", FakeRemote):
            return asyncio.run(bridge.remote_operation(
                {"remoteCertPath": "unused", "remoteKeyPath": "unused", "host": "127.0.0.1"},
                {"operation": "power", "power": desired},
            ))

    def test_off_to_on_uses_guarded_power(self):
        result = self.run_power(False, "on")
        self.assertTrue(result["confirmed"])
        self.assertEqual(FakeRemote.commands, ["POWER"])

    def test_on_to_off_uses_guarded_power(self):
        result = self.run_power(True, "off")
        self.assertTrue(result["confirmed"])
        self.assertEqual(FakeRemote.commands, ["POWER"])

    def test_already_correct_sends_nothing(self):
        result = self.run_power(False, "off")
        self.assertTrue(result["confirmed"])
        self.assertEqual(FakeRemote.commands, [])

    def test_unknown_refuses_toggle(self):
        result = self.run_power(None, "off")
        self.assertEqual(result["code"], "power_state_unknown")
        self.assertEqual(FakeRemote.commands, [])

    def test_unreachable_power_on_wakes_once_then_connects(self):
        FakeRemote.next_power = True
        wake = {"macAddress": "02:11:22:33:44:55", "broadcastAddress": "192.168.1.255"}
        with patch.object(bridge, "AndroidTVRemote", FakeRemote), \
                patch.object(bridge, "remote_port_available", new=AsyncMock(side_effect=[False, True])), \
                patch.object(bridge, "send_wake_packet") as send, \
                patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            response = asyncio.run(bridge.remote_operation(
                {"remoteCertPath": "unused", "remoteKeyPath": "unused", "host": "192.168.1.106", "wake": wake},
                {"operation": "power", "power": "on", "timeoutMs": 30000},
            ))
        send.assert_called_once_with(wake)
        self.assertEqual(response["wakeSent"], True)
        self.assertEqual(response["confirmed"], True)
        self.assertEqual(FakeRemote.commands, [])

    def test_available_remote_uses_guarded_power_without_wake(self):
        FakeRemote.next_power = False
        FakeRemote.commands = []
        wake = {"macAddress": "02:11:22:33:44:55", "broadcastAddress": "192.168.1.255"}
        with patch.object(bridge, "AndroidTVRemote", FakeRemote), \
                patch.object(bridge, "remote_port_available", new=AsyncMock(return_value=True)), \
                patch.object(bridge, "send_wake_packet") as send:
            response = asyncio.run(bridge.remote_operation(
                {"remoteCertPath": "unused", "remoteKeyPath": "unused", "host": "192.168.1.106", "wake": wake},
                {"operation": "power", "power": "on", "timeoutMs": 30000},
            ))
        send.assert_not_called()
        self.assertEqual(FakeRemote.commands, ["POWER"])
        self.assertEqual(response["confirmed"], True)

    def test_unreachable_status_does_not_wake(self):
        FakeRemote.next_power = False
        wake = {"macAddress": "02:11:22:33:44:55", "broadcastAddress": "192.168.1.255"}
        with patch.object(bridge, "AndroidTVRemote", FakeRemote), patch.object(bridge, "send_wake_packet") as send:
            response = asyncio.run(bridge.remote_operation(
                {"remoteCertPath": "unused", "remoteKeyPath": "unused", "host": "192.168.1.106", "wake": wake},
                {"operation": "status"},
            ))
        send.assert_not_called()
        self.assertEqual(response["power"], "off")

    def test_screenshot_file_is_private_png(self):
        with tempfile.TemporaryDirectory() as root:
            directory = str(Path(root) / "shots")
            image = b"\x89PNG\r\n\x1a\n" + b"synthetic"
            with patch.object(bridge, "adb_run", side_effect=[b"device\n", image]):
                response = bridge.adb_operation({"adb": {"unused": True}}, {
                    "operation": "screenshot", "screenshotDirectory": directory,
                    "screenshotMaxAgeSeconds": 900,
                })
            self.assertEqual(response["ok"], True)
            self.assertEqual(Path(response["path"]).read_bytes(), image)
            if os.name == "posix":
                self.assertEqual(Path(response["path"]).stat().st_mode & 0o777, 0o600)
                self.assertEqual(Path(directory).stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
