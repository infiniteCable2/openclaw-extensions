# Device management

`device-management` is the single owner of device identity, human name, functional kind, room, site ID, model-facing tool references and per-agent grants. It does not contact devices. Technology plugins own their network endpoints, credentials and protocol actions. A device ID must occur in this registry and in exactly one matching technology-plugin config.

Configure `plugins.entries.device-management.config.devices` before enabling the technology plugins. `siteId` is an identity label reserved for later delegation; it does not currently route traffic. All four existing home devices belong to site `example_member`. Do not infer the site from an IP address or agent ID.

Example (replace IDs with the exact currently configured IDs; do not copy endpoints or secrets into this registry):

```json5
{
  devices: [
    { id: "govee_light", name: "Licht am Sofa", kind: "light", siteId: "home_site", room: "Wohnzimmer", provider: "govee", capabilities: ["power", "brightness", "color"], tools: { status: "govee_status", control: "govee_control" }, grants: { example_owner: ["read", "control"], example_member: ["read", "control"] } },
    { id: "fritz_lamp", name: "Lampe auf dem Tisch", kind: "light", siteId: "home_site", room: "Wohnzimmer", provider: "fritz", capabilities: ["power", "power_meter"], tools: { status: "fritz_status", control: "fritz_control" }, grants: { example_owner: ["read", "control"], example_member: ["read", "control"] } },
    { id: "denon_receiver", name: "Receiver", kind: "media_receiver", siteId: "home_site", room: "Wohnzimmer", provider: "denon", capabilities: ["power", "volume", "source", "dab", "fm"], tools: { status: "denon_status", control: "denon_control", stations: "denon_dab_stations" }, grants: { example_owner: ["read", "control"], example_member: ["read", "control"] } },
    { id: "wohnzimmer_tv", name: "Fernseher", kind: "television", siteId: "home_site", room: "Wohnzimmer", provider: "google-tv", capabilities: ["power", "remote", "apps", "observe"], tools: { status: "google_tv_status", control: "google_tv_control", observe: "google_tv_observe", guide: "google_tv_guide" }, grants: { example_owner: ["read", "control", "observe", "guide"], example_member: ["read", "control", "observe", "guide"] } }
  ]
}
```

`device_inventory` lists only assigned devices, their functional kind and which specialized tools the agent may use. Direct technology-tool calls also check this registry at execution time against the current OpenClaw config. `example_other` and `ops` receive no devices in this example. The register is not a substitute for OpenClaw's normal per-agent optional-tool allowlist: enable `device_inventory` and the required technology tools for the intended agents.

Build and validate locally with `pnpm --filter @infinitecable2/openclaw-device-management check`, `test`, and `build`. Install this package with its `dist/`, manifest and package metadata before the dependent technology packages. Each technology package imports the central policy at runtime; an immutable package must therefore include its workspace dependency (for example via `pnpm --filter @infinitecable2/openclaw-govee deploy --prod --legacy <staging-directory>`). Copying only a technology plugin's `dist/` will not work. The staged package and dependency must be validated together before any live switch. No remote-site transport or generic LAN forwarding is implemented by this package.

## One-time cutover from `local-devices`

Use the protected live config as input; never publish it or copy its secret fields into this repository. Preserve every configured device ID. Move each provider's endpoint/UID and timeout to its new technology-plugin config, but move its display name and agent grants only to this registry. For the existing devices, set `siteId: "home_site"` and verify each room and functional kind explicitly; the FRITZ socket powering the table lamp is a `light`. Migrate the TV's existing endpoint configuration by removing its old `allowedAgentIds` and device `name`; set those in this registry. Confirm example_owner and example_member's intended grants and confirm that example_other and Ops remain unassigned.

Enable the new optional tools in example_owner and example_member's OpenClaw profiles. Stage all four new plugin configs and the registry together, validate them without contacting devices, then switch the plugin set atomically and verify `device_inventory`, each status tool and one user-approved control per provider. Remove `plugins.entries.local-devices` and its old tool allowlist in the same cutover; do not leave a fallback duplicate owner. Copy the validated DAB catalog to the new Denon state location before enabling Denon, or explicitly accept that a new audible scan will require user approval. Keep the last validated rollback of the active release. Do not perform this server cutover without the separate production authorization and audit procedure.
