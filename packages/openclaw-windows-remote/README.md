# Windows Remote Assistance

The provider exposes one assigned computer through the existing device registry.
The initial route uses a fixed private IPv4 address. Pairing authenticates the
computer independently of that address using the Windows-MCP access code.

The device requires a native agent grant and a host-verified private requester
on an explicitly configured channel. Calls recheck that authority across the
network boundary. The operator at the computer controls input through the
Windows-MCP panel. A paused session can still return a screenshot.

Register provider `windows-remote` in device-management with its actual package
directory. Register a computer with the same ID as the route. Grant `read`,
`observe` and `control` individually. Add the matching optional tools to the
agent’s existing tool policy. The extension’s tracked examples use fictional
identities.

```json
{
  "devices": [
    {
      "id": "example_computer",
      "host": "192.168.50.20",
      "port": 8000,
      "profileId": "example_owner",
      "channels": ["matrix"]
    }
  ]
}
```

## Pairing

Start Windows-MCP in **Heimnetz mit Zugangscode**. Ask the agent to connect
in the assigned private conversation and give it the nine-digit code when
asked. Approve input on the Windows computer when needed. The extension
passes the code to its pairing subprocess through stdin. The resulting
session credential is kept in memory and stays out of tool responses.

The SPAKE2 transcript authenticates the certificate, which is pinned through
TLS during MCP. The lease permits up to 15 minutes of use and is scoped to one
device, agent and private conversation. Local Stop, a Gateway disconnection or
expiry require a fresh pairing. The tool never retries an input automatically.

The pairing helper needs Python 3 and a trusted shared BoringSSL crypto
library with the native SPAKE2 interface. Use the same source release as the
Windows package, BoringSSL `0.20261105.0` at
`3dc4b63808921e914a3fb1fa61869abc3938781b`. Build the `crypto` target with
`BUILD_SHARED_LIBS=ON`, `OPENSSL_NO_ASM=ON` and `BUILD_TESTING=OFF`. Install
the resulting `libcrypto.so` and the BoringSSL license alongside `pair.py`.

## Tool roles

- `windows_remote_status` accepts the access code when pairing is needed and
  reads the attended session’s state.
- `windows_remote_observe` returns accessibility elements by default. Request
  a bounded primary-display PNG when Windows does not expose useful elements.
- `windows_remote_control` clicks, scrolls, enters plain text, presses a single
  key or a named shortcut, or disconnects the associated session. For clicks
  and text entry, use a fresh accessibility element number when available.
  To submit a field after typing, send a separate Enter key if requested.

Keep the immutable provider release and its device-management runtime
dependency together. Run the package check, test and build before activation.
