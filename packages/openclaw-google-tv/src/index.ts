import { readFileSync } from "node:fs";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseTvConfig, type TvConfig } from "./config.js";
import { createTools, controlSchema, guideSchema, observeSchema, statusSchema } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema || typeof manifest.configSchema !== "object") throw new Error("google-tv manifest is missing configSchema");

const runtimes = new WeakMap<object, TvConfig>();
function toolFor(api: OpenClawPluginApi, agentId: string | undefined, name: string) {
  let config = runtimes.get(api);
  if (!config) {
    config = parseTvConfig(api.pluginConfig);
    runtimes.set(api, config);
  }
  if (!agentId || !config.allowedAgentIds.has(agentId)) return undefined;
  return createTools(config).find((tool) => tool.name === name);
}

export default defineToolPlugin({
  id: "google-tv", name: "Google TV",
  description: "Bounded Remote v2 control with optional paired ADB observation.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.google-tv.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({ name: "google_tv_status", label: "Google TV Status", description: "Read configured TV state and capabilities.", parameters: statusSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_status") }),
    tool({ name: "google_tv_control", label: "Google TV Control", description: "Control a configured TV using explicit bounded actions.", parameters: controlSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_control") }),
    tool({ name: "google_tv_observe", label: "Google TV Observe", description: "Observe Android UI using paired ADB; does not capture HDMI.", parameters: observeSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_observe") }),
    tool({ name: "google_tv_guide", label: "Google TV Guide", description: "Read optional app-specific recipes on demand.", parameters: guideSchema as never, optional: true, factory: ({ api, toolContext }) => toolFor(api, toolContext.agentId, "google_tv_guide") }),
  ],
});
