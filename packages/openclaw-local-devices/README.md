# OpenClaw Local Devices

Native, bounded OpenClaw tools for configured devices on the Gateway LAN.

The backends use local, documented receiver and smart-home interfaces:

- Govee LAN API: status, power, brightness, RGB color, and color temperature over UDP.
- FRITZ! Smart Home REST API: status, power, and measured power for a configured switchable unit.
- Denon CEOL: power, volume, mute, CD/tuner/optical/analog input, FM/DAB band and station movement, configured DAB station by name, tone/balance, and HEOS playback. Denon control runs over TCP 23, HEOS metadata/playback/mute over TCP 1255, and volume/mute/tone/band alternatives over local UPnP port 60006.

The receiver tool exposes one logical action per function. `via` can explicitly choose a documented
interface for volume, mute, source or radio band; the default route changes interface only when
the first connection fails before a command is sent. If a command was sent but its result is
uncertain, the tool reports that uncertainty and does not replay a potentially duplicate action.
These are alternative command interfaces, not a promise of fully independent failover: power
readback and power-on still require Denon control on TCP 23. UPnP band readback works independently
once the receiver is already on, but the plugin will not guess power state after losing TCP 23.

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
          denon: {
            devices: [
              {
                id: "receiver_living_room",
                name: "Receiver Wohnzimmer",
                address: "192.168.1.57",
                dabStations: [
                  { id: "energy_berlin", name: "ENERGY Berlin", reportedName: "ENERGY B" },
                ],
              },
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
- Denon station selection walks up to 24 existing DAB entries and confirms each step by HEOS.
  It does not create or overwrite presets. If the station list changes or the requested entry is
  outside that bound, the tool reports failure and the receiver may remain on the last station.
- FM frequency uses the receiver's `TFAN` control/readback scale (MHz × 100). A fresh `TFAN?`
  readback is authoritative for FM tuning; HEOS now-playing text is used only for DAB station
  names because its FM display can lag or disagree. In standby, tuner fields describe the last
  selected setting, not active playback.
- Receiver status lists the supported input names and interface alternatives. It intentionally
  does not expose account settings, firmware operations, network configuration, or arbitrary
  HEOS service searches to an agent.
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
