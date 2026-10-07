import { readFileSync } from "node:fs";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { authorizedDevices, parseDeviceRegistry, publicDevice, registryFromOpenClawConfig } from "./policy.js";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema?: unknown };
if (!manifest.configSchema || typeof manifest.configSchema !== "object") throw new Error("device-management manifest is missing configSchema");

export default defineToolPlugin({
  id: "device-management",
  name: "Device Management",
  description: "Agent-scoped inventory of managed devices, sites and available device tools.",
  activation: { onStartup: false, onConfigPaths: ["plugins.entries.device-management.config"] },
  configSchema: manifest.configSchema as never,
  tools: (tool) => [
    tool({
      name: "device_inventory",
      label: "Device Inventory",
      description: "List only devices assigned to this agent, including kind, site, room, capabilities and the appropriate technology-plugin tools. This does not query live state or discover a LAN.",
      parameters: { type: "object", additionalProperties: false, properties: {
        device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
      } } as never,
      optional: true,
      factory: ({ api, toolContext }) => {
        const agentId = toolContext.agentId;
        if (!agentId) return undefined;
        const registry = parseDeviceRegistry(api.pluginConfig);
        if (authorizedDevices(registry, agentId).length === 0) return undefined;
        return {
          name: "device_inventory",
          label: "Device Inventory",
          description: "List devices assigned to this agent and their technology-plugin tools.",
          parameters: { type: "object", additionalProperties: false, properties: {
            device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
          } },
          execute: async (_toolCallId: string, params: unknown) => {
            const requested = params && typeof params === "object" && "device" in params ? (params as { device?: unknown }).device : undefined;
            if (requested !== undefined && typeof requested !== "string") return jsonResult({ ok: false, error: { code: "invalid_request" } });
            const current = registryFromOpenClawConfig(api.runtime.config.current());
            const visible = authorizedDevices(current, agentId).filter((device) => !requested || device.id === requested);
            return jsonResult({ ok: true, devices: visible.map((device) => publicDevice(device, agentId)) });
          },
        };
      },
    }),
  ],
});
