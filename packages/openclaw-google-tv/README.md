# OpenClaw Google TV

One OpenClaw tool plugin, two explicit transports. Android TV Remote v2 handles power, navigation, input and configured app links. Paired Wi-Fi ADB is optional and restricted to Android-surface screenshots, accessible UI structure, safe text input and configured Leanback app launches. It is not an unrestricted shell. There is no automatic transport fallback or automatic re-enabling of Wi-Fi debugging.

The agent sees four optional tools: `google_tv_status`, `google_tv_control`, `google_tv_observe`, `google_tv_guide`. `allowedAgentIds` is enforced at tool registration. Agents must also explicitly allow these optional tools in their OpenClaw profile. ADB absence does not prevent Remote v2 control. `sent: true` is not proof of a visible state transition; inspect `confirmed` separately. Screenshots never promise HDMI or protected-video capture. CEC forwarding to an HDMI device may work but is not equivalent to direct control of that device.

## Install

Build the package with `pnpm --filter @infinitecable2/openclaw-google-tv build`. Install its immutable package contents under a root-owned release directory, preserving `dist/`, `runtime/`, `openclaw.plugin.json` and `package.json`. The Python executable configured in `pythonPath` must have `androidtvremote2` installed. Remote v2 certificate and key are created by a separate, user-approved pairing step and stay outside this repository. Optional ADB must already be paired and use a dedicated `home` and server port. Do not copy ADB pairing material or Remote v2 keys into this package.

Configure `plugins.entries.google-tv.config` with `allowedAgentIds`, `pythonPath`, and named `devices`. For each device provide its private `host`, protected `remoteCertPath` and `remoteKeyPath`. Optional `adb` has `path`, `home`, `serial`, `serverPort`. Optional `apps` maps stable IDs to either `remote` app links or `adb` Android package names. No arbitrary URL, package, command or host can be supplied by the agent. Set `recipeDirectory` to a separate root-owned directory with reviewed `<app-id>.md` files. Recipes are loaded only by `google_tv_guide`.

Example (placeholder values only):

```json
{
  "allowedAgentIds": ["example_owner", "example_member"],
  "pythonPath": "/opt/google-tv-python/bin/python",
  "recipeDirectory": "/opt/openclaw-tv-recipes",
  "devices": [{
    "id": "wohnzimmer_tv", "name": "Fernseher Wohnzimmer", "host": "192.168.1.10",
    "remoteCertPath": "/etc/openclaw/tv/client.crt", "remoteKeyPath": "/etc/openclaw/tv/client.key",
    "adb": { "path": "/opt/android/adb", "home": "/var/lib/openclaw/androidtv-adb-home", "serial": "paired-device" },
    "apps": [{ "id": "ard", "name": "ARD Mediathek", "via": "adb", "locator": "de.swr.avp.ard.tv" }]
  }]
}
```

Operational acceptance: check status and agent visibility; read Android UI on Home; send a single bounded navigation key; open a configured app and check foreground state; verify HDMI screenshot reports unavailable. Do not test power transitions, app playback, or developer settings without approval for those specific actions. Roll back plugin activation/configuration and restore the previous validated release if the gateway fails to start.
