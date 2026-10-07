# Govee LAN plugin

Install the immutable package contents (`dist/`, `openclaw.plugin.json`, `package.json`) and its `@infinitecable2/openclaw-device-management` dependency. Configure `plugins.entries.govee.config.devices` with exact IDs and private IPv4 LAN addresses. Names, site, room and agent grants are configured only in `device-management` with provider `govee`; its devices use `govee_status` and `govee_control`.

The plugin retains the bounded UDP Govee LAN implementation, including coordinated status reads. It exposes power, brightness, RGB and color-temperature actions. It does not discover hosts or accept an agent-supplied address. Build/check/test using `pnpm --filter @infinitecable2/openclaw-govee <command>`.
