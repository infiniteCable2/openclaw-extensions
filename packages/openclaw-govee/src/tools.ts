import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { assertDeviceGrant, authorizedDevices, type DeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import { GoveeLanBackend, GoveeLanStatusCoordinator, readGoveeStatuses } from "./govee.js";
import type { GoveeConfig, } from "./config.js";
import { LocalDeviceError, type DeviceAction } from "./types.js";

export const statusSchema = { type: "object", additionalProperties: false, properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
} } satisfies AnyAgentTool["parameters"];
export const controlSchema = { type: "object", additionalProperties: false, required: ["device", "action"], properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
  action: { type: "string", enum: ["turn_on", "turn_off", "set_brightness", "set_color", "set_color_temperature"] },
  brightness: { type: "integer", minimum: 1, maximum: 100 },
  red: { type: "integer", minimum: 0, maximum: 255 }, green: { type: "integer", minimum: 0, maximum: 255 }, blue: { type: "integer", minimum: 0, maximum: 255 },
  kelvin: { type: "integer", minimum: 2000, maximum: 9000 },
} } satisfies AnyAgentTool["parameters"];

function action(params: Record<string, unknown>): DeviceAction {
  const integer = (key: string, min: number, max: number): number => {
    const value = params[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new LocalDeviceError("invalid_request", `${key} is invalid`);
    return value;
  };
  switch (params.action) {
    case "turn_on": case "turn_off": return { type: params.action };
    case "set_brightness": return { type: "set_brightness", brightness: integer("brightness", 1, 100) };
    case "set_color": return { type: "set_color", red: integer("red", 0, 255), green: integer("green", 0, 255), blue: integer("blue", 0, 255) };
    case "set_color_temperature": return { type: "set_color_temperature", kelvin: integer("kelvin", 2000, 9000) };
    default: throw new LocalDeviceError("invalid_request", "Unsupported Govee action");
  }
}

export function buildGoveeBackends(config: GoveeConfig, registry: DeviceRegistry): Map<string, GoveeLanBackend> {
  const coordinator = new GoveeLanStatusCoordinator();
  return new Map(config.devices.map((entry) => {
    const managed = registry.get(entry.id);
    if (!managed || managed.provider !== "govee") throw new Error(`Govee device ${entry.id} has no matching management entry`);
    return [entry.id, new GoveeLanBackend({ ...entry, name: managed.name }, config.requestTimeoutMs, undefined, coordinator)] as const;
  }));
}

export function createGoveeTools(config: GoveeConfig, registry: DeviceRegistry, agentId: string, currentRegistry: () => DeviceRegistry = () => registry, sharedBackends?: ReadonlyMap<string, GoveeLanBackend>): AnyAgentTool[] {
  const backends = sharedBackends ?? buildGoveeBackends(config, registry);
  const permitted = (permission: "read" | "control") => authorizedDevices(currentRegistry(), agentId)
    .filter((device) => device.provider === "govee" && device.grants.get(agentId)?.has(permission) && backends.has(device.id));
  return [
    { name: "govee_status", label: "Govee Status", description: "Read assigned Govee lights; device_inventory describes room and site.", parameters: statusSchema,
      execute: async (_callId, params, signal) => {
        const input = params as { device?: string };
        const selected = permitted("read").filter((device) => !input.device || device.id === input.device).map((device) => backends.get(device.id)!);
        try { return jsonResult({ ok: true, devices: [...(await readGoveeStatuses(selected, signal)).values()] }); }
        catch { return jsonResult({ ok: false, error: { code: "device_unavailable" } }); }
      } },
    { name: "govee_control", label: "Govee Control", description: "Control one assigned Govee light.", parameters: controlSchema,
      execute: async (_callId, params, signal) => {
        try {
          const input = params as Record<string, unknown>;
          const id = String(input.device ?? "");
          assertDeviceGrant(currentRegistry(), agentId, id, "govee", "control");
          const backend = backends.get(id);
          if (!backend) throw new LocalDeviceError("unknown_device", "Govee device is not configured");
          return jsonResult({ ok: true, device: await backend.control(action(input), signal) });
        } catch (error) { return jsonResult({ ok: false, error: { code: error instanceof LocalDeviceError ? error.code : "device_denied" } }); }
      } },
  ];
}
