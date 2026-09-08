# OpenClaw Local Devices

Native, bounded OpenClaw tools for configured devices on the Gateway LAN.

The first stable backends deliberately cover only documented interfaces:

- Govee LAN API: status, power, brightness, RGB color, and color temperature over UDP.
- FRITZ! Smart Home REST API: status, power, and measured power for a configured switchable unit.

The plugin registers `local_device_status` and `local_device_control` only for explicitly allowed
agent IDs. It never scans arbitrary hosts during agent tool execution, never returns device network
addresses or private hardware identifiers to the model, and does not depend on Voicecore.

## Build and test

From the `openclaw-extensions` workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @infinitecable2/openclaw-local-devices check
pnpm --filter @infinitecable2/openclaw-local-devices test
pnpm --filter @infinitecable2/openclaw-local-devices build
```

## OpenClaw configuration

Use stable logical device IDs. Keep transport addresses, FRITZ! unit IDs, and credentials out of
agent prompts and workspaces. This example uses a protected store SecretRef; do not put the password
directly in `openclaw.json`.

```json5
{
  plugins: {
    entries: {
      "local-devices": {
        enabled: true,
        config: {
          allowedAgentIds: ["steffen", "astrid"],
          requestTimeoutMs: 5000,
          govee: {
            devices: [
              { id: "living_light", name: "Wohnzimmerlicht", address: "192.168.1.25" },
            ],
          },
          fritz: {
            baseUrl: "http://fritz.box",
            username: "openclaw-smarthome",
            password: {
              source: "store",
              provider: "default",
              id: "FRITZ_SMARTHOME_PASSWORD",
            },
            devices: [
              { id: "socket_lamp", name: "Steckdosenlampe", uid: "configured-unit-id" },
            ],
          },
        },
      },
    },
  },
}
```

Also allow both tool names in the effective `tools.allow` policy of each intended agent. Do not add
them to `bodo`, `ops`, or a global/default allowlist. The plugin-side `allowedAgentIds` is a second,
independent gate; both gates must permit the tool.

Create a dedicated FRITZ!Box user with only the Smart Home permission needed for this integration.
Enter `FRITZ_SMARTHOME_PASSWORD` as a protected value through OpenClaw's masked Secrets UI or
`openclaw secrets store`; never place it in shell history or chat. Validate configuration while the
Gateway is stopped, and run `openclaw secrets audit --check` after setup.

## Operational boundaries

- Govee devices must be configured by private IPv4 address and have LAN control enabled.
- The FRITZ! base URL may only be `fritz.box` or a private IPv4 HTTP(S) origin.
- At most 16 devices are accepted across all providers.
- Status responses are bounded and projected onto a small, non-sensitive schema.
- Control tools are marked side-effecting and non-replay-safe.
- Unsupported device capabilities fail closed instead of falling through to another provider.

Device discovery is an administrator-only installation step. It is intentionally not available as
an agent tool.

## Future backends

Undocumented Govee `ptReal` scene and segment control is not part of the stable LAN backend. If it is
added, keep it behind an explicit experimental configuration flag, implement its packet codec as a
pure function with fixture tests for the prefix, scene offset, Base64 encoding, and XOR checksum,
and require an explicit device capability declaration. Never silently fall back from a documented
command to an undocumented one.

For assistant devices in other networks, add a paired OpenClaw node transport behind the same device
backend interface. The Gateway remains the sole owner of agents, sessions, authorization, audit, and
logical device IDs; the remote node only performs the explicitly addressed LAN operation.
