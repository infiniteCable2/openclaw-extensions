import { readFileSync } from "node:fs";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { authorizedDevices, registryFromOpenClawConfig } from "@infinitecable2/openclaw-device-management/policy";
import { parseGoveeConfig } from "./config.js";
import { buildGoveeBackends, controlSchema, createGoveeTools, statusSchema } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema) throw new Error("Govee manifest is missing configSchema");
type Runtime = { config: ReturnType<typeof parseGoveeConfig>; registry: ReturnType<typeof registryFromOpenClawConfig>; backends: ReturnType<typeof buildGoveeBackends>; tools: Map<string, ReturnType<typeof createGoveeTools>> };
const runtimes = new WeakMap<object, Runtime>();
function resolveTool(api: OpenClawPluginApi, agentId: string | undefined, name: string) {
  if (!agentId) return undefined;
  const registry = registryFromOpenClawConfig(api.config);
  const permission = name === "govee_status" ? "read" : "control";
  if (!authorizedDevices(registry, agentId).some((device) => device.provider === "govee" && device.grants.get(agentId)?.has(permission))) return undefined;
  let runtime = runtimes.get(api);
  if (!runtime) { const config = parseGoveeConfig(api.pluginConfig); runtime = { config, registry, backends: buildGoveeBackends(config, registry), tools: new Map() }; runtimes.set(api, runtime); }
  let tools = runtime.tools.get(agentId);
  if (!tools) { tools = createGoveeTools(runtime.config, runtime.registry, agentId, () => registryFromOpenClawConfig(api.runtime.config.current()), runtime.backends); runtime.tools.set(agentId, tools); }
  return tools.find((tool) => tool.name === name);
}
export default defineToolPlugin({
  id: "govee", name: "Govee", description: "Bounded Govee LAN light control.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.govee.config", "plugins.entries.device-management.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({ name: "govee_status", label: "Govee Status", description: "Read assigned Govee lights.", parameters: statusSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "govee_status") }),
    tool({ name: "govee_control", label: "Govee Control", description: "Control an assigned Govee light.", parameters: controlSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "govee_control") }),
  ],
});
