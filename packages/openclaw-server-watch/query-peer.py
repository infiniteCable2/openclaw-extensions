"""Serve one bounded query from the local systemd-owned Gateway process."""
import json
import os
from pathlib import Path
import pwd
import socket
import struct
import subprocess
import sys

MAX_REQUEST = 8192
MAX_REPLY = 512 * 1024
UNIT = "openclaw-gateway.service"
WORKER = Path(__file__).with_name("query-worker.mjs")


def peer_is_gateway(client):
    creds = client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", creds)
    if pid <= 1 or uid != pwd.getpwnam("openclaw").pw_uid:
        return False
    owner = subprocess.run(
        ["/usr/bin/systemctl", "show", UNIT, "-p", "MainPID", "--value"],
        capture_output=True, text=True, timeout=1, check=True,
    )
    return owner.stdout.strip() == str(pid)


def serve(client):
    client.settimeout(1.5)
    if not peer_is_gateway(client):
        return b'{"ok":false,"error":"server_watch_peer_denied"}'
    with client.makefile("rb") as request:
        payload = request.readline(MAX_REQUEST + 1)
    if not payload.endswith(b"\n") or len(payload) > MAX_REQUEST:
        return b'{"ok":false,"error":"invalid_request"}'
    result = subprocess.run(
        ["/usr/bin/node", str(WORKER), sys.argv[1]],
        input=payload, capture_output=True, timeout=3.5, check=True,
        env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "NODE_NO_WARNINGS": "1"},
    )
    if len(result.stdout) > MAX_REPLY:
        return b'{"ok":false,"error":"server_watch_reply_too_large"}'
    return result.stdout


if __name__ == "__main__":
    with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as peer:
        try:
            response = serve(peer)
        except (OSError, subprocess.SubprocessError, ValueError):
            response = b'{"ok":false,"error":"server_watch_unavailable"}'
        try:
            peer.sendall(response)
        except OSError:
            pass
