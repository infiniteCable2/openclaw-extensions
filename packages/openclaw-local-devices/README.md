# OpenClaw Local Devices

Native, bounded OpenClaw tools for configured devices on the Gateway LAN.

The backends use local, documented receiver and smart-home interfaces:

- Govee LAN API: status, power, brightness, RGB color, and color temperature over UDP.
- FRITZ! Smart Home REST API: status, power, and measured power for a configured switchable unit.
- Denon CEOL: power, volume, mute, CD/tuner/optical/analog input, FM/DAB band and station movement, cached DAB station selection, tone/balance, and HEOS playback. Denon control runs over TCP 23, HEOS metadata/playback/mute over TCP 1255, and volume/mute/tone/band alternatives over local UPnP port 60006.

The receiver tool exposes one logical action per function. `via` can explicitly choose a documented
interface for volume, mute, source or radio band; the default route changes interface only when
the first connection fails before a command is sent. If a command was sent but its result is
uncertain, the tool reports that uncertainty and does not replay a potentially duplicate action.
These are alternative command interfaces, not a promise of fully independent failover: power
readback and power-on still require Denon control on TCP 23. UPnP band readback works independently
once the receiver is already on, but the plugin will not guess power state after losing TCP 23.

The plugin registers `local_device_status`, `local_device_dab_stations`, and `local_device_control` only for explicitly allowed
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
              },
            ],
          },
        },
      },
    },
  },
}
```

Also allow all three tool names in the effective `tools.allow` policy of each intended agent. Do not add
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
- DAB status and list reads never retune the receiver. If no cached list exists, the agent must
  offer an audible, roughly two-minute `refresh_dab_stations` operation and wait for the user's
  approval. Refresh requires the receiver to be on, playing the DAB tuner. The plugin walks at most
  128 station steps, confirms names through HEOS, and stores the resulting bounded catalog in
  OpenClaw's persistent plugin state. It does not create or overwrite presets.
- A catalog with uncertain steps is marked partial. Duplicate short names retain scan-order labels
  (`name`, `name_2`, etc.), but those labels are not service IDs. Selecting either duplicate seeks
  the *next* station with that displayed name; the shorter direction is estimated from the cache.
  From one duplicate, selection can therefore move to another, but the receiver cannot prove which
  one. The result reports `dabSelection.confirmed=false` rather than claiming an exact match.
  Unique uncertain names are not offered for selection. A failed or cancelled walk can leave the
  receiver on another station. If the requested name cannot be found, the cache is marked stale;
  the agent should offer a user-approved refresh. Refresh never runs on a status read.
- Remove legacy `denon.devices[].dabStations` entries before activating this plugin version. They
  are no longer accepted; station names must come from a receiver scan, not static configuration.
- FM tuning commands use the receiver's `TFAN` wire scale (MHz × 100). On this CEOL, `TFAN?`
  can keep reporting an old frequency even after the receiver audibly changes stations, so FM
  frequency and tuning confirmation come from HEOS now-playing metadata instead. If HEOS does
  not expose a parseable FM frequency, the plugin leaves it unknown rather than reporting the
  stale Telnet value. In standby, no active FM frequency is reported.
- Receiver status lists the supported input names and interface alternatives. It intentionally
  does not expose account settings, firmware operations, network configuration, or arbitrary
  HEOS service searches to an agent.
- Status responses are bounded and projected onto a small, non-sensitive schema.
- Control tools are marked side-effecting and non-replay-safe.
- Unsupported device capabilities fail closed instead of falling through to another provider.

LAN device discovery is an administrator-only installation step. DAB station-list refresh is a
separate, user-approved operation on an already configured receiver; it never scans LAN hosts.

## Future backends

Undocumented Govee `ptReal` scene and segment control is not part of the stable LAN backend. If it is
added, keep it behind an explicit experimental configuration flag, implement its packet codec as a
pure function with fixture tests for the prefix, scene offset, Base64 encoding, and XOR checksum,
and require an explicit device capability declaration. Never silently fall back from a documented
command to an undocumented one.

For assistant devices in other networks, add a paired OpenClaw node transport behind the same device
backend interface. The Gateway remains the sole owner of agents, sessions, authorization, audit, and
logical device IDs; the remote node only performs the explicitly addressed LAN operation.
