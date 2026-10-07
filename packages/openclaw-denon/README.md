# Denon CEOL plugin

Install the immutable package contents (`dist/`, `openclaw.plugin.json`, `package.json`) and its `@infinitecable2/openclaw-device-management` dependency. Configure `plugins.entries.denon.config.devices` with exact IDs and private IPv4 addresses. Names, site, room and grants belong only to `device-management` with provider `denon`; tools are `denon_status`, `denon_control` and `denon_dab_stations`.

The plugin retains Telnet/UPnP/HEOS control, FM tuning and bounded DAB scanning/navigation. New DAB cache files live under the OpenClaw state directory at `denon/dab-catalog-v1`; the previous `local-devices/dab-catalog-v1` must be migrated as a reviewed cutover step or users must consent to a new audible scan. No automatic scan occurs during status reads. Build/check/test using `pnpm --filter @infinitecable2/openclaw-denon <command>`.
