# go-e charger status

`device_inventory` shows the managed charger by name. The assistant passes its inventory ID to `goe_status`, which reads the charging state, charging permission and configured current through the assigned Matrix Node.

1. Load `goe` and `device-management` using their built packages. Point `device-management.config.providers.goe` to the absolute go-e package directory containing `device-provider.json`.
2. Add a managed device with `kind: "ev_charger"`, `provider: "goe"`, its display name, site and room, and a `read` grant for the intended agent.
3. In `goe.config.devices`, bind the same `id` to the existing paired `nodeId` and the private requester `profileId`, with `commands: ["network.device.read"]`. Use one charger binding per Node because the local approval selects one charger. The host must support turn-bound `callGatewayTool` and Matrix Node dispatch for `network.device.read`.
4. Allow `goe_status` and `device_inventory` in the intended agent's tool policy. Keep the existing gateway command and Element approval. Element selects the locally approved charger on its approved Wi-Fi.

Store the real node and profile IDs in the deployment configuration. The tool takes only an inventory `device` ID and exposes only status values. `allowedCurrentAmps` is the configured maximum current, in amps.

Build the plugin against the same OpenClaw SDK that runs on the gateway. Install this device-management revision together with the provider. The inventory uses the host's callable tool view to advertise `goe_status` when the private binding and the connected Node both allow the command. On hosts without this view the inventory shows the assigned charger identity and leaves its callable tools empty.
