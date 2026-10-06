#!/usr/bin/env python3
"""One-request bounded bridge. Never prints credentials, ADB diagnostics, or raw UI XML."""

import asyncio
import base64
import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET

from androidtvremote2 import AndroidTVRemote

KEYS = {
    "up": "DPAD_UP", "down": "DPAD_DOWN", "left": "DPAD_LEFT",
    "right": "DPAD_RIGHT", "select": "DPAD_CENTER", "back": "BACK",
    "home": "HOME", "play_pause": "MEDIA_PLAY_PAUSE", "volume_up": "VOLUME_UP",
    "volume_down": "VOLUME_DOWN", "input": "TV_INPUT",
}
MAX_SCREENSHOT_BYTES = 3_000_000
MAX_UI_BYTES = 300_000


def result(**value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


def adb_run(device, *args, timeout=10, max_bytes=MAX_UI_BYTES):
    settings = device.get("adb")
    if not settings:
        return None
    env = dict(os.environ)
    env["HOME"] = settings["home"]
    command = [settings["path"], "-P", str(settings["serverPort"]), "-s", settings["serial"], *args]
    try:
        proc = subprocess.run(command, env=env, capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode or len(proc.stdout) > max_bytes:
        return None
    return proc.stdout


def adb_operation(device, request):
    operation = request["operation"]
    if not device.get("adb"):
        return {"ok": False, "code": "adb_not_configured"}
    if adb_run(device, "get-state", timeout=4) != b"device\n":
        return {"ok": False, "code": "adb_unavailable"}
    if operation == "text":
        value = request.get("text", "")
        if not isinstance(value, str) or not value or len(value) > 120 or not value.isascii() or any(ch in value for ch in "\r\n\t%;&|<>\\\"'"):
            return {"ok": False, "code": "invalid_text"}
        sent = adb_run(device, "shell", "input", "text", value.replace(" ", "%s")) is not None
        return {"ok": sent, "sent": sent, "confirmed": False, "via": "adb"}
    if operation == "app":
        app = request["app"]
        package = app["locator"]
        if not isinstance(package, str) or not package.replace(".", "").replace("_", "").isalnum() or "." not in package:
            return {"ok": False, "code": "invalid_app_locator"}
        data = adb_run(device, "shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LEANBACK_LAUNCHER", "-p", package)
        if not data:
            return {"ok": False, "code": "leanback_activity_missing"}
        components = [line.strip() for line in data.decode("utf8", "replace").splitlines() if "/" in line]
        component = components[-1] if components else ""
        if not component.startswith(package + "/") or any(ch.isspace() for ch in component):
            return {"ok": False, "code": "leanback_activity_missing"}
        sent = adb_run(device, "shell", "am", "start", "-n", component) is not None
        return {"ok": sent, "sent": sent, "confirmed": False, "via": "adb", "app": app["id"]}
    if operation == "screenshot":
        image = adb_run(device, "exec-out", "screencap", "-p", timeout=8, max_bytes=MAX_SCREENSHOT_BYTES)
        if not image or not image.startswith(b"\x89PNG\r\n\x1a\n"):
            return {"ok": False, "code": "screenshot_unavailable", "scope": "android_surface_only"}
        return {"ok": True, "scope": "android_surface_only", "mimeType": "image/png", "imageBase64": base64.b64encode(image).decode("ascii")}
    if operation == "ui":
        # stdout-only dump fails on some TVs; use an exact per-process temporary path.
        path = f"/sdcard/Download/openclaw-ui-{os.getpid()}.xml"
        try:
            if adb_run(device, "shell", "uiautomator", "dump", path, timeout=8) is None:
                return {"ok": False, "code": "ui_unavailable"}
            xml = adb_run(device, "exec-out", "cat", path, timeout=5)
            if not xml or len(xml) > MAX_UI_BYTES:
                return {"ok": False, "code": "ui_unavailable"}
            root = ET.fromstring(xml)
            nodes = []
            for node in root.iter("node"):
                attrs = node.attrib
                if not any(attrs.get(k) for k in ("text", "content-desc", "resource-id")) and attrs.get("focused") != "true":
                    continue
                nodes.append({"text": attrs.get("text", "")[:120], "description": attrs.get("content-desc", "")[:120], "id": attrs.get("resource-id", "")[:120], "bounds": attrs.get("bounds", ""), "focused": attrs.get("focused") == "true", "clickable": attrs.get("clickable") == "true"})
                if len(nodes) >= 100:
                    break
            return {"ok": True, "scope": "android_surface_only", "nodes": nodes, "truncated": len(nodes) >= 100}
        except ET.ParseError:
            return {"ok": False, "code": "ui_unavailable"}
        finally:
            adb_run(device, "shell", "rm", "-f", path, timeout=3)
    return {"ok": False, "code": "invalid_operation"}


async def remote_operation(device, request):
    operation = request["operation"]
    remote = AndroidTVRemote("OpenClaw Google TV", device["remoteCertPath"], device["remoteKeyPath"], device["host"], enable_ime=False, enable_voice=False)
    try:
        await asyncio.wait_for(remote.async_connect(), timeout=8)
        await asyncio.sleep(0.25)
        power = "on" if remote.is_on is True else "off" if remote.is_on is False else "unknown"
        if operation == "status":
            response = {"ok": True, "remoteAvailable": True, "power": power, "currentApp": remote.current_app or None}
            if device.get("adb"):
                response["adbAvailable"] = adb_run(device, "get-state", timeout=3) == b"device\n"
            return response
        if operation == "power":
            desired = request.get("power")
            if desired not in ("on", "off"):
                return {"ok": False, "code": "invalid_power"}
            if power == desired:
                return {"ok": True, "sent": False, "confirmed": True, "power": power}
            remote.send_key_command("WAKEUP" if desired == "on" else "SLEEP")
        elif operation == "key":
            key = KEYS.get(request.get("key"))
            if not key:
                return {"ok": False, "code": "invalid_key"}
            remote.send_key_command(key)
        elif operation == "app":
            if power != "on":
                return {"ok": False, "code": "television_not_confirmed_on"}
            remote.send_launch_app_command(request["app"]["locator"])
        else:
            return {"ok": False, "code": "invalid_operation"}
        await asyncio.sleep(0.7)
        confirmed = operation == "power" and remote.is_on is not None and (remote.is_on is True) == (request["power"] == "on")
        return {"ok": True, "sent": True, "confirmed": confirmed, "via": "remote", "power": "on" if remote.is_on is True else "off" if remote.is_on is False else "unknown", "currentApp": remote.current_app or None}
    except Exception:
        return {"ok": False, "code": "remote_unavailable"}
    finally:
        remote.disconnect()


def main():
    try:
        request = json.load(sys.stdin)
        device = request["device"]
        if request["operation"] in ("text", "screenshot", "ui") or (request["operation"] == "app" and request["app"]["via"] == "adb"):
            result(**adb_operation(device, request))
        else:
            result(**asyncio.run(remote_operation(device, request)))
    except Exception:
        result(ok=False, code="bridge_error")


if __name__ == "__main__":
    main()
