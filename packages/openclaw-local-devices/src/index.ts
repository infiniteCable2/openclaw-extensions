import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseLocalDevicesConfig } from "./config.js";
import { DabFileCatalogStore } from "./dab-file-store.js";
import {
  buildBackends,
  controlSchema,
  createToolsForAgent,
  dabStationsSchema,
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
  api: OpenClawPluginApi,
  agentId: string | undefined,
  toolName: string,
) {
  let runtime = runtimes.get(api);
  if (!runtime) {
    const config = parseLocalDevicesConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const dabCatalogStore = new DabFileCatalogStore(join(stateDir, "local-devices", "dab-catalog-v1"));
    runtime = { config, backends: buildBackends(config, dabCatalogStore) };
    runtimes.set(api, runtime);
  }
  return createToolsForAgent(runtime.config, runtime.backends, agentId)?.find(
    (candidate) => candidate.name === toolName,
  );
}

export default defineToolPlugin({
  id: "local-devices",
  name: "Local Devices",
  description: "Bounded local control of configured lights, sockets and Denon CEOL receivers.",
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
      name: "local_device_dab_stations",
      label: "DAB Station List",
      description: "Read cached DAB station names without changing the receiver.",
      parameters: dabStationsSchema as never,
      optional: true,
      factory: ({ api, toolContext }) =>
        resolveTool(api, toolContext.agentId, "local_device_dab_stations"),
    }),
    tool({
      name: "local_device_control",
      label: "Local Device Control",
      description: "Control one configured local light, socket or receiver.",
      parameters: controlSchema as never,
      optional: true,
      factory: ({ api, toolContext }) =>
        resolveTool(api, toolContext.agentId, "local_device_control"),
    }),
  ],
});
