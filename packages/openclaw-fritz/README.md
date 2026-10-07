# FRITZ! Smart Home plugin

Ship `device-provider.json` with the immutable package. It owns the supported capabilities and tool references consumed by device management; these are not copied into each device entry.

Install the immutable package contents (`dist/`, `openclaw.plugin.json`, `package.json`) and its `@infinitecable2/openclaw-device-management` dependency. Configure `plugins.entries.fritz.config` with a protected `username`, a secret-referenced `password`, optional private `baseUrl`, and `devices` containing only exact IDs and FRITZ! unit UIDs. The name, functional kind (a lamp connected to a socket may be `light`), site, room and agent grants belong only to `device-management` with provider `fritz`; tools are `fritz_status` and `fritz_control`.

The plugin retains bounded FRITZ! authentication and switch-state confirmation. Do not put the password in tracked files. Build/check/test using `pnpm --filter @infinitecable2/openclaw-fritz <command>`.
