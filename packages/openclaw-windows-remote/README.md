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
      "channels": ["matrix"],
      "credentialFile": "/var/lib/openclaw/windows-remote/example_computer.json"
    }
  ]
}
```

## Pairing

On the computer, start Windows-MCP in **Heimnetz mit Zugangscode**. An operator
runs `pair.py` in an interactive terminal as the Gateway’s runtime Unix user
with that computer’s configured host, port and lease-file path. The operator
enters the short-lived code at the hidden prompt. The code belongs in that
prompt. The operator can then ask the agent to read the computer’s status in
the assigned private conversation. Approve input on the Windows computer if
the conversation needs to use it.

Use a private directory owned by the Gateway account for the pairing files.
The helper writes a mode-0600 lease atomically. The certificate is authenticated
by the SPAKE2 transcript and pinned through TLS during MCP. The lease permits
up to 15 minutes of use. Session state is scoped to one device, agent and
private conversation. Local Stop, a Gateway disconnection, or expiry require
a fresh pairing. The tool never retries a desktop input automatically.

The operator helper needs Python 3 and a trusted shared BoringSSL crypto
library with the native SPAKE2 interface. Use the same source release as the
Windows package, BoringSSL `0.20261105.0` at
`3dc4b63808921e914a3fb1fa61869abc3938781b`. Build the `crypto` target with
`BUILD_SHARED_LIBS=ON`, `OPENSSL_NO_ASM=ON` and `BUILD_TESTING=OFF`. Pass
the resulting absolute library path using `--crypto-library`. Use
`--lease-file` for the matching operator-configured path. Retain the
BoringSSL license.

## Tool roles

- `windows_remote_status` opens the attended session and reads its state.
- `windows_remote_observe` returns a bounded primary-display PNG.
- `windows_remote_control` sends one explicitly selected mouse action or
  navigation shortcut, or disconnects the associated session.

Keep the immutable provider release and its device-management runtime
dependency together. Run the package check, test and build before activation.
