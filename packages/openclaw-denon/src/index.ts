import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { authorizedDevices, registryFromOpenClawConfig } from "@infinitecable2/openclaw-device-management/policy";
import { parseDenonConfig } from "./config.js";
import { DabFileCatalogStore } from "./dab-file-store.js";
import { buildDenonBackends, controlSchema, createDenonTools, dabStationsSchema, statusSchema } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema) throw new Error("Denon manifest is missing configSchema");
type Runtime = { config: ReturnType<typeof parseDenonConfig>; registry: ReturnType<typeof registryFromOpenClawConfig>; store: DabFileCatalogStore; backends: ReturnType<typeof buildDenonBackends>; tools: Map<string, ReturnType<typeof createDenonTools>> };
const runtimes = new WeakMap<object, Runtime>();
function resolveTool(api: OpenClawPluginApi, agentId: string | undefined, name: string) {
  if (!agentId) return undefined;
  const registry = registryFromOpenClawConfig(api.config);
  const permission = name === "denon_control" ? "control" : "read";
  if (!authorizedDevices(registry, agentId).some((device) => device.provider === "denon" && device.grants.get(agentId)?.has(permission))) return undefined;
  let runtime = runtimes.get(api);
  if (!runtime) {
    const config = parseDenonConfig(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const store = new DabFileCatalogStore(join(stateDir, "denon", "dab-catalog-v1"));
    runtime = { config, registry, store, backends: buildDenonBackends(config, registry, store), tools: new Map() };
    runtimes.set(api, runtime);
  }
  let tools = runtime.tools.get(agentId);
  if (!tools) { tools = createDenonTools(runtime.config, runtime.registry, agentId, runtime.store, () => registryFromOpenClawConfig(api.runtime.config.current()), runtime.backends); runtime.tools.set(agentId, tools); }
  return tools.find((tool) => tool.name === name);
}
export default defineToolPlugin({
  id: "denon", name: "Denon", description: "Bounded Denon CEOL receiver control.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.denon.config", "plugins.entries.device-management.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({ name: "denon_status", label: "Denon Status", description: "Read assigned Denon receivers.", parameters: statusSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "denon_status") }),
    tool({ name: "denon_dab_stations", label: "Denon DAB Stations", description: "Read cached DAB station list.", parameters: dabStationsSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "denon_dab_stations") }),
    tool({ name: "denon_control", label: "Denon Control", description: "Control an assigned Denon receiver.", parameters: controlSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "denon_control") }),
  ],
});
