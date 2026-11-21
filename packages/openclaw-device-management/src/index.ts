import { readFileSync } from "node:fs";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import * as toolPluginSdk from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  canInspectDevicePermissions,
  deviceUsesNodeRules,
  projectInventoryDevice,
  type InventoryNode,
  type IsToolCallable,
} from "./inventory.js";
import { authorizedDevices, registryFromOpenClawConfig } from "./policy.js";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema?: unknown };
if (!manifest.configSchema || typeof manifest.configSchema !== "object") {
  throw new Error("device-management manifest is missing configSchema");
}

// Older gateways still show assigned device identities. Function names only
// come from a host-provided callable catalog.
const { bindCallablePluginToolView } = toolPluginSdk as typeof toolPluginSdk & {
  bindCallablePluginToolView?: <T extends AnyAgentTool>(
    tool: T,
    update: (view: IsToolCallable) => void,
  ) => T;
};

export default definePluginEntry({
  id: "device-management",
  name: "Device Management",
  description: "Inventory of assigned devices and functions available in the current conversation.",
  configSchema: manifest.configSchema as never,
  register(api) {
    for (const diagnostic of [false, true]) {
      const name = diagnostic ? "device_inventory_diagnostics" : "device_inventory";
      const label = diagnostic ? "Device Permission Diagnostics" : "Device Inventory";
      const description = diagnostic
        ? "Read installed device capabilities and diagnose their current availability. Requires a private operator's diagnostic permission."
        : "List assigned devices and the device functions callable in this conversation.";
      api.registerTool(
        {
          contextVersion: 2,
          create(context: OpenClawPluginToolContext<2>) {
            const { agentId } = context;
            if (!agentId) return undefined;
            if (
              diagnostic
                ? !canInspectDevicePermissions(api.pluginConfig, context)
                : authorizedDevices(
                    registryFromOpenClawConfig(api.runtime.config.current()),
                    agentId,
                  ).length === 0
            ) {
              return undefined;
            }
            let isToolCallable: IsToolCallable = () => false;
            const tool: AnyAgentTool = {
              name,
              label,
              description,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: { device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" } },
              } as never,
              execute: async (_toolCallId, params) => {
                context.assertInvocationCurrent();
                const requested =
                  params && typeof params === "object" && "device" in params
                    ? params.device
                    : undefined;
                if (requested !== undefined && typeof requested !== "string") {
                  return jsonResult({ ok: false, error: { code: "invalid_request" } });
                }
                const config = api.runtime.config.current();
                const entries = config.plugins?.entries;
                if (
                  diagnostic &&
                  !canInspectDevicePermissions(entries?.["device-management"]?.config, context)
                ) {
                  return jsonResult({ ok: false, error: { code: "device_diagnostics_denied" } });
                }
                const registry = registryFromOpenClawConfig(config);
                const visible = (
                  diagnostic ? [...registry.values()] : authorizedDevices(registry, agentId)
                ).filter((device) => requested === undefined || device.id === requested);
                let nodes = new Map<string, InventoryNode>();
                if (visible.some(deviceUsesNodeRules)) {
                  try {
                    const listed = await api.runtime.nodes.list();
                    nodes = new Map(listed.nodes.map((node) => [node.nodeId, node]));
                  } catch {
                    // Keep device identity available without claiming unsupported commands.
                  }
                }
                context.assertInvocationCurrent();
                if (api.runtime.config.current() !== config) {
                  return jsonResult({ ok: false, error: { code: "device_configuration_changed" } });
                }
                return jsonResult({
                  ok: true,
                  devices: visible.map((device) =>
                    projectInventoryDevice({
                      device,
                      providerConfig: entries?.[device.provider]?.config,
                      context,
                      isToolCallable,
                      nodes,
                      diagnostic,
                    }),
                  ),
                });
              },
            };
            return (
              bindCallablePluginToolView?.(tool, (view) => {
                isToolCallable = view;
              }) ?? tool
            );
          },
        },
        { name, optional: true },
      );
    }
  },
});
