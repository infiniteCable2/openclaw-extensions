# go-e charger status

`device_inventory` shows managed chargers by name. `goe_status` reads the charging state, charging permission and configured current through the assigned Matrix Node. It automatically selects a single charger available to the current private requester. When several chargers are available, pass the inventory ID of the selected charger.

1. Load `goe` and `device-management` using their built packages. Point `device-management.config.providers.goe` to the absolute go-e package directory containing `device-provider.json`.
2. Add a managed device with `kind: "ev_charger"`, `provider: "goe"`, its display name, site and room, and a `read` grant for the intended agent.
3. In `goe.config.devices`, bind the same `id` to the existing paired `nodeId` and the private requester `profileId`. For a compatible Node, set `commands: ["network.device.read.v2"]` and the approved charger's six-digit `deviceKey`. Each charger on the same Node needs a distinct key. A Node with a single assignment may use `commands: ["network.device.read"]` without a key until it supports v2. The host must support the selected Matrix Node command through turn-bound `callGatewayTool`.
4. Allow `goe_status` and `device_inventory` in the intended agent's tool policy. Keep the existing gateway command and Element approval. Element selects the locally approved charger on its approved Wi-Fi.

Store the real node ID, profile ID and device key in the deployment configuration. The only tool argument is the optional inventory `device` ID. The extension accepts a v2 result only when Element confirms the assigned device key. The tool output contains the inventory ID and status values. `allowedCurrentAmps` is the configured maximum current, in amps.

The tool reports stable error categories for session authority, assignment, node availability, deadlines and known Android failures. A transport handoff without a confirmed Android result returns `device_dispatch_unconfirmed`. Each error contains a fixed description.

When Element reports a specific discovery rejection, the tool distinguishes an unconfirmed Wi-Fi network, a missing or mismatched service serial number, and a service address that Android could not resolve. Earlier Element versions can still report the general discovery failure or discovery timeout.

Build the plugin against the same OpenClaw SDK that runs on the gateway. Install this device-management revision together with the provider. The inventory uses the host's callable tool view to advertise `goe_status` when the private binding and the connected Node both allow the command. On hosts without this view the inventory shows the assigned charger identity and leaves its callable tools empty.
