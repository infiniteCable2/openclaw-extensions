# OpenClaw Google TV

One OpenClaw tool plugin, two explicit transports. Android TV Remote v2 handles power, navigation, input and configured app links. An optional, per-device Wake-on-LAN/WLAN magic packet can bring a sleeping TV's Remote v2 listener back before `power_on`; status, other controls and `power_off` never wake it. Paired Wi-Fi ADB is optional and restricted to Android-surface screenshots, accessible UI structure, safe text input and configured Leanback app launches. It is not an unrestricted shell. There is no automatic transport fallback or automatic re-enabling of Wi-Fi debugging.

The agent sees four optional tools: `google_tv_status`, `google_tv_control`, `google_tv_observe`, `google_tv_guide`. Device identity, name, `siteId`, room and per-agent grants are owned by `device-management`; direct TV tool calls recheck those grants at execution. Agents must also explicitly allow these optional tools in their OpenClaw profile. ADB absence does not prevent Remote v2 control. `sent: true` is not proof of a visible state transition; inspect `confirmed` separately. Screenshots never promise HDMI or protected-video capture. CEC forwarding to an HDMI device may work but is not equivalent to direct control of that device.

`google_tv_observe(mode="screenshot")` defaults to `delivery="file"`: it stores the original PNG privately and returns an absolute path for a later `view_image` call. `delivery="context"` adds a JPEG preview capped at 350 KB directly to the tool result; `delivery="both"` supplies the preview and original-file path together. The inline preview may lose fine text detail, so use `both` or `file` when exact UI text matters. Files are mode 0600 in a mode-0700 dedicated directory. The Gateway schedules deletion after `screenshotMaxAgeSeconds` (default 900); the next screenshot also prunes expired files if a restart interrupted that timer. Configure host temporary-file cleanup too if exact expiry must survive a restart without another capture. No screenshot is automatically sent to a chat user.

## Install

Build the package with `pnpm --filter @infinitecable2/openclaw-google-tv build`. Install its immutable package contents under a root-owned release directory, preserving `dist/`, `runtime/`, `openclaw.plugin.json` and `package.json`, together with its `@infinitecable2/openclaw-device-management` dependency. The Python executable configured in `pythonPath` must have `androidtvremote2` installed. Remote v2 certificate and key are created by a separate, user-approved pairing step and stay outside this repository. Optional ADB must already be paired and use a dedicated `home` and server port. Do not copy ADB pairing material or Remote v2 keys into this package.

Configure `plugins.entries.google-tv.config` with `pythonPath` and devices identified by their exact management IDs. For each device provide its private `host`, protected `remoteCertPath` and `remoteKeyPath`. Optional `adb` has `path`, `home`, `serial`, `serverPort`. Optional `apps` maps stable IDs to either `remote` app links or `adb` Android package names. No arbitrary URL, package, command or host can be supplied by the agent. Set `recipeDirectory` to a separate root-owned directory with reviewed `<app-id>.md` files. Recipes are loaded only by `google_tv_guide`.

For a TV that closes Remote v2 in deep standby, set optional `wake.macAddress` and `wake.broadcastAddress` to the verified device MAC and its local subnet broadcast address. The TV must have Wake-on-WLAN/LAN enabled and the gateway host must be allowed to send the packet on that subnet. The plugin sends one magic packet only for `power_on` when Remote v2 is unavailable, then waits for the listener and applies the guarded power operation. Set `powerOnTimeoutMs` (default 30000) independently of the ordinary `requestTimeoutMs` (default 15000). Set `screenshotDirectory` to a dedicated directory under OpenClaw's media allowlist (for example `<state>/media/google-tv`); if omitted, it defaults to `$OPENCLAW_STATE_DIR/media/google-tv` or `~/.openclaw/media/google-tv`.

Example (placeholder values only):

```json
{
  "pythonPath": "/opt/google-tv-python/bin/python",
  "recipeDirectory": "/opt/openclaw-tv-recipes",
  "screenshotDirectory": "/var/lib/openclaw/media/google-tv",
  "devices": [{
    "id": "wohnzimmer_tv", "host": "192.168.1.10",
    "remoteCertPath": "/etc/openclaw/tv/client.crt", "remoteKeyPath": "/etc/openclaw/tv/client.key",
    "wake": { "macAddress": "02:11:22:33:44:55", "broadcastAddress": "192.168.1.255" },
    "adb": { "path": "/opt/android/adb", "home": "/var/lib/openclaw/androidtv-adb-home", "serial": "paired-device" },
    "apps": [{ "id": "ard", "name": "ARD Mediathek", "via": "adb", "locator": "de.swr.avp.ard.tv" }]
  }]
}
```

Operational acceptance: check status and agent visibility; read Android UI on Home; send a single bounded navigation key; open a configured app and check foreground state; verify HDMI screenshot reports unavailable. Do not test power transitions, app playback, or developer settings without approval for those specific actions. Roll back plugin activation/configuration and restore the previous validated release if the gateway fails to start.
