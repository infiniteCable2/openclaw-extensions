import { readFileSync } from "node:fs";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { parseLocalDevicesConfig } from "./config.js";
import {
  buildBackends,
  controlSchema,
  createToolsForAgent,
  statusSchema,
} from "./tools.js";
import type { DeviceBackend, LocalDevicesConfig } from "./types.js";

type Runtime = {
  config: LocalDevicesConfig;
  backends: ReadonlyMap<string, DeviceBackend>;
};

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema?: unknown };

if (!manifest.configSchema || typeof manifest.configSchema !== "object") {
  throw new Error("local-devices manifest is missing configSchema");
}

const runtimes = new WeakMap<object, Runtime>();

function resolveTool(
  api: { pluginConfig?: unknown },
  agentId: string | undefined,
  toolName: string,
) {
  let runtime = runtimes.get(api);
  if (!runtime) {
    const config = parseLocalDevicesConfig(api.pluginConfig);
    runtime = { config, backends: buildBackends(config) };
    runtimes.set(api, runtime);
  }
  return createToolsForAgent(runtime.config, runtime.backends, agentId)?.find(
    (candidate) => candidate.name === toolName,
  );
}

export default defineToolPlugin({
  id: "local-devices",
  name: "Local Devices",
  description: "Bounded local control of configured Govee and FRITZ! Smart Home devices.",
  activation: {
    onStartup: false,
    onConfigPaths: ["plugins.entries.local-devices.config"],
  },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({
      name: "local_device_status",
      label: "Local Device Status",
      description: "Read the current state of configured local devices.",
      parameters: statusSchema as never,
      optional: true,
      factory: ({ api, toolContext }) =>
        resolveTool(api, toolContext.agentId, "local_device_status"),
    }),
    tool({
      name: "local_device_control",
      label: "Local Device Control",
      description: "Control one configured local light or socket.",
      parameters: controlSchema as never,
      optional: true,
      factory: ({ api, toolContext }) =>
        resolveTool(api, toolContext.agentId, "local_device_control"),
    }),
  ],
});
