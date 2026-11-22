# go-e charger operations

`device_inventory` shows managed chargers by name. `goe_status` uses the assigned node and private requester binding. It automatically selects a single charger available to the current requester. When several chargers are available, pass the inventory ID of the selected charger.

The optional `section` argument selects one group. `charging` is the default and preserves the basic status from earlier nodes. Nodes with telemetry add charging power in kW, current by phase, phase mode, cable state and energy since the vehicle was plugged in. `grid` gives measured voltage, frequency and grid diagnostics. `device` gives reachability, firmware, error, temperature and energy information as the charger provides it. `history` gives completed sessions from the configured export. Its `limit` defaults to 3 and accepts 1–20 sessions.

1. Load `goe` and `device-management` using their built packages. Point `device-management.config.providers.goe` to the absolute go-e package directory containing `device-provider.json`.
2. Add a managed device with `kind: "ev_charger"`, `provider: "goe"`, its display name, site and room, and a `read` grant for the intended agent.
3. In `goe.config.devices`, bind the same `id` to the existing paired `nodeId` and the private requester `profileId`. For a compatible Node, set `commands: ["network.device.read.v2"]` and the approved charger's six-digit `deviceKey`. Each charger on the same Node needs a distinct key. A Node with a single assignment may use `commands: ["network.device.read"]` without a key until it supports v2. The host must support the selected Matrix Node command through turn-bound `callGatewayTool`.
4. Allow `goe_status` and `device_inventory` in the intended agent's tool policy. Keep the existing gateway command and Element approval. Element selects the locally approved charger on its approved Wi-Fi.

Store the real node ID, profile ID and device key in the deployment configuration. The extension accepts a v2 result only when the node confirms the assigned device key. `allowedCurrentAmps` is the currently allowed current, in amps.

### Completed sessions

On an addressed assignment the operator can configure `historyReport` as an absolute path to a trusted UTF-8 report file on the gateway. The reader accepts comma, semicolon or tab delimiters, explicit timezone offsets, energy in kWh and optional active duration in seconds. Use the documented column names in the tested format. Rows are selected by the assigned six-digit charger serial, sorted by end time and projected to dates, energy and duration. The tool provides the file modification time so the requester can see the age of the configured report. The manufacturer's local HTTP API documents an export link. A gateway operator manages report updates through the supported manufacturer export.

### Confirmed charging stop

`goe_stop` requires an addressed charger, the agent's separate inventory `control` grant, a current private turn and an invocable `network.device.stop.v1` command on the assigned node. The node asks the requester to confirm before acting, verifies charger identity and reports the outcome. With an already inactive charger it reports `alreadyStopped`. A verified `stopped` result is force-off on the charger. Restore automatic operation in the go-e app when desired. Check the live charge state following an unconfirmed stop result.

The tool reports stable error categories for session authority, assignment, node availability, deadlines and known Android failures. A transport handoff without a confirmed Android result returns `device_dispatch_unconfirmed`. Each error contains a fixed description.

When Element reports a specific discovery rejection, the tool distinguishes an unconfirmed Wi-Fi network, a missing or mismatched service serial number, and a service address that Android could not resolve. Earlier Element versions can still report the general discovery failure or discovery timeout.

Build the plugin against the same OpenClaw SDK that runs on the gateway. Install this device-management revision together with the provider. The inventory uses the host's callable tool view to advertise `goe_status` when the private binding and the connected Node both allow the command. On hosts without this view the inventory shows the assigned charger identity and leaves its callable tools empty.
