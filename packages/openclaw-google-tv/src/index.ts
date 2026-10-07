import { readFileSync } from "node:fs";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { authorizedDevices, registryFromOpenClawConfig } from "@infinitecable2/openclaw-device-management/policy";
import { parseTvConfig, type TvConfig } from "./config.js";
import { createTools, controlSchema, guideSchema, observeSchema, statusSchema } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema || typeof manifest.configSchema !== "object") throw new Error("google-tv manifest is missing configSchema");

const runtimes = new WeakMap<object, Map<string, ReturnType<typeof createTools>>>();
function toolFor(api: OpenClawPluginApi, agentId: string | undefined, name: string) {
  if (!agentId) return undefined;
  const registry = registryFromOpenClawConfig(api.config);
  const permission = name === "google_tv_status" ? "read" : name === "google_tv_control" ? "control" : name === "google_tv_observe" ? "observe" : "guide";
  if (!authorizedDevices(registry, agentId).some((device) => device.provider === "google-tv" && device.grants.get(agentId)?.has(permission))) return undefined;
  let byAgent = runtimes.get(api);
  if (!byAgent) { byAgent = new Map(); runtimes.set(api, byAgent); }
  let tools = byAgent.get(agentId);
  if (!tools) { tools = createTools(parseTvConfig(api.pluginConfig), registry, agentId, () => registryFromOpenClawConfig(api.runtime.config.current())); byAgent.set(agentId, tools); }
  return tools.find((tool) => tool.name === name);
}

export default defineToolPlugin({
  id: "google-tv", name: "Google TV",
  description: "Bounded Remote v2 control with optional paired ADB observation.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.google-tv.config", "plugins.entries.device-management.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({ name: "google_tv_status", label: "Google TV Status", description: "Read configured TV state and capabilities.", parameters: statusSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_status") }),
    tool({ name: "google_tv_control", label: "Google TV Control", description: "Control a configured TV using explicit bounded actions.", parameters: controlSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_control") }),
    tool({ name: "google_tv_observe", label: "Google TV Observe", description: "Observe Android UI using paired ADB; does not capture HDMI.", parameters: observeSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_observe") }),
    tool({ name: "google_tv_guide", label: "Google TV Guide", description: "Read optional app-specific recipes on demand.", parameters: guideSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_guide") }),
  ],
});
