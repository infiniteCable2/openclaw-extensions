#!/usr/bin/env python3
"""Operator-only Windows-MCP access-code pairing. Never run through an agent tool."""

import argparse
import ctypes
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import ssl
import stat
import sys
import tempfile
import time
from getpass import getpass
from pathlib import Path


CLIENT = b"Windows-MCP assistance client v1"
SERVER = b"Windows-MCP assistance host v1"
DOMAIN = b"Windows-MCP assistance TLS binding v1\0"
PRIVATE = tuple(ipaddress.IPv4Network(net) for net in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
))


def expect_hex(value, size):
    if not isinstance(value, str) or not re.fullmatch(f"[0-9a-f]{{{size * 2}}}", value):
        raise ValueError("Unexpected message format")
    return bytes.fromhex(value)


def load_crypto(library: Path):
    crypto = ctypes.CDLL(str(library.resolve(strict=True)))
    ptr, size, data = ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p
    crypto.SPAKE2_CTX_new.argtypes = [ctypes.c_int, data, size, data, size]
    crypto.SPAKE2_CTX_new.restype = ptr
    crypto.SPAKE2_CTX_free.argtypes = [ptr]
    crypto.SPAKE2_CTX_free.restype = None
    for operation in (crypto.SPAKE2_generate_msg, crypto.SPAKE2_process_msg):
        operation.argtypes = [ptr, ptr, ctypes.POINTER(size), size, data, size]
        operation.restype = ctypes.c_int
    return crypto


def exchange(operation, state, incoming, capacity):
    outgoing = ctypes.create_string_buffer(capacity)
    length = ctypes.c_size_t()
    if not operation(state, outgoing, ctypes.byref(length), capacity, incoming, len(incoming)):
        raise ValueError("Pairing rejected")
    return outgoing.raw[:length.value]


def post(host, port, tls, path, data):
    connection = http.client.HTTPSConnection(host, port, timeout=7, context=tls)
    try:
        connection.request("POST", path, json.dumps(data), {"Content-Type": "application/json"})
        response = connection.getresponse()
        body = response.read(1025)
        if response.status != 200 or len(body) > 1024:
            raise ValueError("Pairing rejected")
        parsed = json.loads(body)
        if not isinstance(parsed, dict):
            raise ValueError("Unexpected response")
        return parsed
    finally:
        connection.close()


def pair(host, port, code, crypto):
    # The initial TLS handshake obtains only a public certificate. The SPAKE2
    # confirmation authenticates that certificate before using the MCP bearer.
    pem = ssl.get_server_certificate((host, port), timeout=7)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    tls.load_verify_locations(cadata=pem)
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).digest()
    state = crypto.SPAKE2_CTX_new(0, CLIENT, len(CLIENT), SERVER, len(SERVER))
    if not state:
        raise ValueError("Could not start pairing")
    try:
        client_message = exchange(crypto.SPAKE2_generate_msg, state, code.encode("ascii"), 32)
        reply = post(host, port, tls, "/fernhilfe/pair/start", {"message": client_message.hex()})
        nonce = expect_hex(reply.get("id"), 16)
        server_message = expect_hex(reply.get("message"), 32)
        proof = expect_hex(reply.get("proof"), 32)
        key = exchange(crypto.SPAKE2_process_msg, state, server_message, 64)
    finally:
        crypto.SPAKE2_CTX_free(state)

    def derive(role):
        transcript = DOMAIN + role + b"\0" + fingerprint + nonce + client_message + server_message
        return hmac.digest(key, transcript, "sha256")

    if not hmac.compare_digest(proof, derive(b"server")):
        raise ValueError("Code or target identity did not match")
    reply = post(host, port, tls, "/fernhilfe/pair/finish", {
        "id": nonce.hex(), "proof": derive(b"client").hex(),
    })
    if reply.get("ok") is not True:
        raise ValueError("Pairing rejected")
    return pem, derive(b"mcp-token").hex()


def save_lease(path, lease):
    if not path.is_absolute():
        raise ValueError("The lease path must be absolute")
    parent = path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("Use a private pairing directory owned by the Gateway user")
    handle, name = tempfile.mkstemp(prefix=".windows-remote-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="ascii") as output:
            json.dump(lease, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Pair an assigned Windows-MCP computer locally")
    parser.add_argument("--host", required=True, type=ipaddress.IPv4Address)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--crypto-library", required=True, type=Path)
    parser.add_argument("--lease-file", required=True, type=Path)
    args = parser.parse_args()
    if not any(args.host in network for network in PRIVATE) or not 1024 <= args.port <= 65535:
        parser.error("Use the assigned private LAN IPv4 address and port.")
    if not sys.stdin.isatty():
        parser.error("Run this command interactively so the access code is hidden.")
    try:
        crypto = load_crypto(args.crypto_library)
        code = getpass("Windows-MCP access code: ").replace(" ", "").replace("-", "")
        if not re.fullmatch(r"[0-9]{9}", code):
            raise ValueError("Invalid access code")
        pem, token = pair(str(args.host), args.port, code, crypto)
        save_lease(args.lease_file, {
            "host": str(args.host),
            "port": args.port,
            "certificate": pem,
            "token": token,
            "expiresAt": int(time.time() * 1000) + 15 * 60_000,
        })
    except (ValueError, OSError, http.client.HTTPException, AttributeError):
        parser.exit(1, "Pairing failed. Check the assigned endpoint, access code and local setup.\n")
    print("Pairing ready. OpenClaw can connect from the assigned private conversation.")


if __name__ == "__main__":
    main()
