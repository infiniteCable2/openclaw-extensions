"""No-network tests for the exact TV power semantics."""
import asyncio
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch


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


if __name__ == "__main__":
    unittest.main()
