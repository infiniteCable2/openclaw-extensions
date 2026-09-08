import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseLocalDevicesConfig } from "./config.js";
import { buildBackends, createToolsForAgent } from "./tools.js";

export default definePluginEntry({
  id: "local-devices",
  name: "Local Devices",
  description: "Bounded local control of configured Govee and FRITZ! Smart Home devices.",
  register(api) {
    const config = parseLocalDevicesConfig(api.pluginConfig);
    const backends = buildBackends(config);
    api.registerTool(
      (context) => createToolsForAgent(config, backends, context.agentId),
      {
        names: ["local_device_status", "local_device_control"],
        optional: true,
      },
    );
  },
});
