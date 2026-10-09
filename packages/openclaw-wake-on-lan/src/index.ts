import { readFileSync } from "node:fs";
import { authorizedDevices } from "@infinitecable2/openclaw-device-management/policy";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { createWakeOnLanTools, stateFromOpenClawConfig, statusSchema, wakeSchema } from "./tools.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema) throw new Error("Wake-on-LAN manifest is missing configSchema");

function resolveTool(api: OpenClawPluginApi, agentId: string | undefined, name: string) {
  if (!agentId) return undefined;
  const state = stateFromOpenClawConfig(api.config);
  const permission = name === "wake_on_lan_status" ? "read" : "control";
  if (!authorizedDevices(state.registry, agentId).some((device) => device.provider === "wake-on-lan" && device.grants.get(agentId)?.has(permission))) return undefined;
  return createWakeOnLanTools(agentId, () => stateFromOpenClawConfig(api.runtime.config.current())).find((tool) => tool.name === name);
}

export default defineToolPlugin({
  id: "wake-on-lan", name: "Wake on LAN",
  description: "Agent-scoped Wake-on-LAN for explicitly configured managed devices.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.wake-on-lan.config", "plugins.entries.device-management.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({ name: "wake_on_lan_status", label: "Wake on LAN Status", description: "Read configured WoL capability without network traffic; device power state remains unknown.", parameters: statusSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "wake_on_lan_status") }),
    tool({ name: "wake_on_lan", label: "Wake on LAN", description: "Send one magic packet to a configured assigned device; sending does not confirm wake or readiness.", parameters: wakeSchema as never, optional: true, factory: ({ api, toolContext }) => resolveTool(api, toolContext.agentId, "wake_on_lan") }),
  ],
});
