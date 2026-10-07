import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { assertDeviceGrant, authorizedDevices, type DeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import type { FritzConfig } from "./config.js";
import { FritzSmartHomeBackend } from "./fritz.js";
import { LocalDeviceError } from "./types.js";

export const statusSchema = { type: "object", additionalProperties: false, properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
} } satisfies AnyAgentTool["parameters"];
export const controlSchema = { type: "object", additionalProperties: false, required: ["device", "action"], properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
  action: { type: "string", enum: ["turn_on", "turn_off"] },
} } satisfies AnyAgentTool["parameters"];

export function buildFritzBackends(config: FritzConfig, registry: DeviceRegistry): Map<string, FritzSmartHomeBackend> {
  return new Map(config.devices.map((entry) => {
    const managed = registry.get(entry.id);
    if (!managed || managed.provider !== "fritz") throw new Error(`FRITZ device ${entry.id} has no matching management entry`);
    return [entry.id, new FritzSmartHomeBackend({ ...entry, name: managed.name }, config.baseUrl, config.username, config.password, config.requestTimeoutMs)] as const;
  }));
}

export function createFritzTools(config: FritzConfig, registry: DeviceRegistry, agentId: string, currentRegistry: () => DeviceRegistry = () => registry, sharedBackends?: ReadonlyMap<string, FritzSmartHomeBackend>): AnyAgentTool[] {
  const backends = sharedBackends ?? buildFritzBackends(config, registry);
  const permitted = () => authorizedDevices(currentRegistry(), agentId).filter((device) => device.provider === "fritz" && device.grants.get(agentId)?.has("read") && backends.has(device.id));
  return [
    { name: "fritz_status", label: "FRITZ Smart Home Status", description: "Read assigned FRITZ Smart Home devices.", parameters: statusSchema,
      execute: async (_callId, params, signal) => {
        const input = params as { device?: string };
        const results = await Promise.all(permitted().filter((device) => !input.device || device.id === input.device).map(async (device) => {
          try { return await backends.get(device.id)!.status(signal); }
          catch { return { id: device.id, available: false, power: "unknown", error: { code: "device_unavailable" } }; }
        }));
        return jsonResult({ ok: true, devices: results });
      } },
    { name: "fritz_control", label: "FRITZ Smart Home Control", description: "Switch an assigned FRITZ Smart Home device on or off.", parameters: controlSchema,
      execute: async (_callId, params, signal) => {
        try {
          const input = params as { device?: unknown; action?: unknown };
          const id = String(input.device ?? "");
          assertDeviceGrant(currentRegistry(), agentId, id, "fritz", "control");
          const backend = backends.get(id);
          if (!backend) throw new LocalDeviceError("unknown_device", "FRITZ device is not configured");
          if (input.action !== "turn_on" && input.action !== "turn_off") throw new LocalDeviceError("invalid_request", "Unsupported FRITZ action");
          return jsonResult({ ok: true, device: await backend.control({ type: input.action }, signal) });
        } catch (error) { return jsonResult({ ok: false, error: { code: error instanceof LocalDeviceError ? error.code : "device_denied" } }); }
      } },
  ];
}
