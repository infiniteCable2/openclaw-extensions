import { readFileSync } from "node:fs";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { authorizedDevices, registryFromOpenClawConfig } from "@infinitecable2/openclaw-device-management/policy";
import { parseFritzConfig } from "./config.js";
import { buildFritzBackends, controlSchema, createFritzTools, statusSchema } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema) throw new Error("FRITZ manifest is missing configSchema");
type Runtime = { config: ReturnType<typeof parseFritzConfig>; registry: ReturnType<typeof registryFromOpenClawConfig>; backends: ReturnType<typeof buildFritzBackends>; tools: Map<string, ReturnType<typeof createFritzTools>> };
const runtimes = new WeakMap<object, Runtime>();
function resolveTool(api: OpenClawPluginApi, agentId: string | undefined, name: string) {
  if (!agentId) return undefined;
  const registry = registryFromOpenClawConfig(api.config);
  const permission = name === "fritz_status" ? "read" : "control";
  if (!authorizedDevices(registry, agentId).some((device) => device.provider === "fritz" && device.grants.get(agentId)?.has(permission))) return undefined;
  let runtime = runtimes.get(api);
  if (!runtime) { const config = parseFritzConfig(api.pluginConfig); runtime = { config, registry, backends: buildFritzBackends(config, registry), tools: new Map() }; runtimes.set(api, runtime); }
  let tools = runtime.tools.get(agentId);
  if (!tools) { tools = createFritzTools(runtime.config, runtime.registry, agentId, () => registryFromOpenClawConfig(api.runtime.config.current()), runtime.backends); runtime.tools.set(agentId, tools); }
  return tools.find((tool) => tool.name === name);
}
export default defineToolPlugin({
  id: "fritz", name: "FRITZ Smart Home", description: "Bounded FRITZ Smart Home control.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.fritz.config", "plugins.entries.device-management.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({ name: "fritz_status", label: "FRITZ Status", description: "Read assigned FRITZ devices.", parameters: statusSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "fritz_status") }),
    tool({ name: "fritz_control", label: "FRITZ Control", description: "Control an assigned FRITZ device.", parameters: controlSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "fritz_control") }),
  ],
});
