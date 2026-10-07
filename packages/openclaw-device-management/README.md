# Device management

`device-management` owns device identity, human name, functional kind, room, site ID and per-agent grants. It does not contact devices. Technology plugins own their network endpoints, pairing/credentials, protocol actions and metadata. Each plugin ships a versioned `device-provider.json`; the manager combines its capabilities and role-to-tool references with the centrally assigned devices. A device ID must occur in this registry and in exactly one matching technology-plugin config.

`providers` binds each provider ID to its absolute immutable package directory, the same release used by OpenClaw. The manager reads bounded JSON data and checks the provider ID and tool references against the package's native `openclaw.plugin.json` contracts. No executable module is loaded from these paths. Per-device `capabilities` or `tools` overrides are rejected; old configurations must be migrated. The capability list describes what the provider supports, while its status tool reports current availability (for example, whether optional ADB is configured or reachable).

Configure `plugins.entries.device-management.config.devices` before enabling the technology plugins. `siteId` is an identity label reserved for later delegation; it does not currently route traffic. All four existing home devices belong to site `astrid`. Do not infer the site from an IP address or agent ID.

Example (replace IDs with the exact currently configured IDs; do not copy endpoints or secrets into this registry):

```json5
{
  providers: {
    govee: "/opt/openclaw-plugins/govee-release",
    fritz: "/opt/openclaw-plugins/fritz-release",
    denon: "/opt/openclaw-plugins/denon-release",
    "google-tv": "/opt/openclaw-plugins/google-tv-release"
  },
  devices: [
    { id: "govee_light", name: "Licht am Sofa", kind: "light", siteId: "astrid", room: "Wohnzimmer", provider: "govee", grants: { steffen: ["read", "control"], astrid: ["read", "control"] } },
    { id: "fritz_lamp", name: "Lampe auf dem Tisch", kind: "light", siteId: "astrid", room: "Wohnzimmer", provider: "fritz", grants: { steffen: ["read", "control"], astrid: ["read", "control"] } },
    { id: "denon_receiver", name: "Receiver", kind: "media_receiver", siteId: "astrid", room: "Wohnzimmer", provider: "denon", grants: { steffen: ["read", "control"], astrid: ["read", "control"] } },
    { id: "wohnzimmer_tv", name: "Fernseher", kind: "television", siteId: "astrid", room: "Wohnzimmer", provider: "google-tv", grants: { steffen: ["read", "control", "observe", "guide"], astrid: ["read", "control", "observe", "guide"] } }
  ]
}
```

`device_inventory` lists only assigned devices, their functional kind and which specialized tools the agent may use. Direct technology-tool calls also check this registry at execution time against the current OpenClaw config. `bodo` and `ops` receive no devices in this example. The register is not a substitute for OpenClaw's normal per-agent optional-tool allowlist: enable `device_inventory` and the required technology tools for the intended agents.

Pairing material and device-derived caches (such as the Denon station list) are shared per device. Request artifacts such as TV screenshots are stored under the requesting agent and device. Neither the registry nor plugin metadata holds personal agent memory. Agent-specific preferences and conversation history stay in OpenClaw's existing agent/session storage. App recipes remain a shared, reviewed collection for now. Artifact directory scoping is organizational; it does not create an operating-system isolation boundary between agents with broad file or shell access.

Build and validate locally with `pnpm --filter @infinitecable2/openclaw-device-management check`, `test`, and `build`. Install this package with its `dist/`, manifest and package metadata before the dependent technology packages. Each technology package imports the central policy at runtime; an immutable package must therefore include its workspace dependency (for example via `pnpm --filter @infinitecable2/openclaw-govee deploy --prod --legacy <staging-directory>`). Copying only a technology plugin's `dist/` will not work. The staged package and dependency must be validated together before any live switch. No remote-site transport or generic LAN forwarding is implemented by this package.

## One-time cutover from `local-devices`

Use the protected live config as input; never publish it or copy its secret fields into this repository. Preserve every configured device ID. Move each provider's endpoint/UID and timeout to its new technology-plugin config, but move its display name and agent grants only to this registry. For the existing devices, set `siteId: "astrid"` and verify each room and functional kind explicitly; the FRITZ socket powering the table lamp is a `light`. Migrate the TV's existing endpoint configuration by removing its old `allowedAgentIds` and device `name`; set those in this registry. Confirm Steffen and Astrid's intended grants and confirm that Bodo and Ops remain unassigned.

Enable the new optional tools in Steffen and Astrid's OpenClaw profiles. Stage all four new plugin configs and the registry together, including each plugin's `device-provider.json` and the matching `providers` directory references. Remove any manually configured per-device capabilities and tool names. Validate without contacting devices, then switch the plugin set atomically and verify `device_inventory`, each status tool and one user-approved control per provider. Remove `plugins.entries.local-devices` and its old tool allowlist in the same cutover; do not leave a fallback duplicate owner. Copy the validated DAB catalog to the new Denon state location before enabling Denon, or explicitly accept that a new audible scan will require user approval. Keep the last validated rollback of the active release. Do not perform this server cutover without the separate production authorization and audit procedure.
