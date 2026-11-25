import { readFileSync } from "node:fs";
import type { AnyAgentTool, OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  assertDeviceGrant, authorizedDevices, DevicePolicyError, hasDeviceProvider, registryFromOpenClawConfig,
} from "@infinitecable2/openclaw-device-management/policy";
import { withThermostat } from "./mqtt.js";
import {
  controlPlan, days, deviceIdPattern, historyTypes, ieeePattern, integer, modeValues, readPlan, record,
  temporaryModes, ThermostatError,
} from "./protocol.js";

const provider = "thermostat";
const name = "Zigbee Thermostat";
const description = "Read and operate assigned SONOFF TRV-ZBT radiator thermostats through local Zigbee2MQTT.";
const activation = {
  onStartup: false,
  onConfigPaths: ["plugins.entries.thermostat.config", "plugins.entries.device-management.config"],
};
const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as { configSchema: unknown };
const device = { type: "string", pattern: deviceIdPattern };
const group = { type: "integer", minimum: 1, maximum: 3 };
const temperatureC = { type: "number", minimum: 5, maximum: 30, multipleOf: 0.5 };
const scheduleDay = {
  type: "array", minItems: 1, maxItems: 12,
  items: {
    type: "object", additionalProperties: false, required: ["time", "temperatureC"],
    properties: { time: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }, temperatureC },
  },
};

const tools = [
  {
    name: "thermostat_status", label: "Thermostat Status", permission: "read",
    description: "Read the status, settings, diagnostics, schedule or temperature history of an assigned radiator thermostat. Schedule requires a group (1–3). For history provide resolution and timestamps with time zones.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        device, group,
        section: { type: "string", enum: ["status", "settings", "diagnostics", "schedule", "history"] },
        historyType: { type: "string", enum: [...historyTypes] },
        from: { type: "string", maxLength: 30 }, to: { type: "string", maxLength: 30 },
      },
    },
  },
  {
    name: "thermostat_control", label: "Thermostat Control", permission: "control",
    description: "Set a radiator thermostat's temperature, mode (heat is manual, auto is the weekly schedule, off keeps frost protection), schedule, boost/timer or adaptive PID. Changing the mode preserves the weekly schedule.",
    parameters: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        device, group, temperatureC,
        action: { type: "string", enum: ["set_temperature", "set_mode", "select_schedule", "set_schedule", "set_temporary_mode", "set_pid"] },
        mode: { type: "string", enum: [...modeValues] },
        schedule: { type: "object", additionalProperties: false, properties: Object.fromEntries(days.map((day) => [day, scheduleDay])) },
        temporaryMode: { type: "string", enum: [...temporaryModes] },
        durationMinutes: { type: "integer", minimum: 1, maximum: 1440 },
        enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "thermostat_calibrate", label: "Calibrate Thermostat Valve", permission: "control",
    description: "Run the thermostat's physical valve travel calibration. Only use this when explicitly requested, then pass confirm: true.",
    parameters: {
      type: "object", additionalProperties: false, required: ["confirm"],
      properties: { device, confirm: { type: "boolean", const: true } },
    },
  },
] satisfies Array<Pick<AnyAgentTool, "name" | "label" | "description" | "parameters"> & { permission: "read" | "control" }>;

function routeFor(value: unknown, id: string) {
  const config = record(value);
  if (!Array.isArray(config.devices) || config.devices.length < 1 || config.devices.length > 16) throw badRoute();
  const addresses = new Map<string, string>();
  const count = new Set<string>();
  for (const entry of config.devices) {
    const { id: deviceId, ieeeAddress } = record(entry);
    if (typeof deviceId !== "string" || !new RegExp(deviceIdPattern).test(deviceId) || addresses.has(deviceId) ||
        typeof ieeeAddress !== "string" || !new RegExp(ieeePattern).test(ieeeAddress) || count.has(ieeeAddress)) throw badRoute();
    addresses.set(deviceId, ieeeAddress);
    count.add(ieeeAddress);
  }
  const address = addresses.get(id);
  const baseTopic = config.baseTopic ?? "zigbee2mqtt";
  if (!address || typeof baseTopic !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(baseTopic)) throw badRoute();
  return {
    address, baseTopic, port: integer(config.port ?? 1883, 1, 65535, "Port"),
    timeoutMs: integer(config.timeoutMs ?? 18000, 2000, 45000, "Timeout"),
  };
}

function badRoute(): ThermostatError {
  return new ThermostatError("device_configuration_invalid", "The thermostat needs a unique, configured Zigbee address.");
}

function permitted(config: unknown, agentId: string | undefined, permission: "read" | "control") {
  return authorizedDevices(registryFromOpenClawConfig(config), agentId).filter((entry) =>
    hasDeviceProvider(entry, provider) && entry.grants.get(agentId ?? "")?.has(permission));
}

type Tool = (typeof tools)[number];

function toolFor(api: OpenClawPluginApi, context: OpenClawPluginToolContext, tool: Tool): AnyAgentTool | undefined {
  const { agentId } = context;
  if (!agentId || !permitted(api.config, agentId, tool.permission).length) return undefined;
  return {
    name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
    execute: async (_callId, params, signal) => {
      try {
        const input = record(params);
        const config = api.runtime.config.current();
        const id = input.device ?? (() => {
          const available = permitted(config, agentId, tool.permission);
          if (available.length === 1) return available[0]!.id;
          throw new ThermostatError("device_selection_required", "Select an assigned thermostat from device_inventory.");
        })();
        if (typeof id !== "string" || !new RegExp(deviceIdPattern).test(id)) {
          throw new ThermostatError("invalid_request", "Select a valid device ID from device_inventory.");
        }
        const managed = assertDeviceGrant(registryFromOpenClawConfig(config), agentId, id, provider, tool.permission);
        const connection = routeFor(config.plugins?.entries?.[provider]?.config, id);
        const authorize = () => {
          context.assertInvocationCurrent?.();
          const current = api.runtime.config.current();
          assertDeviceGrant(registryFromOpenClawConfig(current), agentId, id, provider, tool.permission);
          const route = routeFor(current.plugins?.entries?.[provider]?.config, id);
          if (route.address !== connection.address || route.port !== connection.port || route.baseTopic !== connection.baseTopic) {
            throw new ThermostatError("device_assignment_changed", "The thermostat assignment changed during the request.");
          }
        };
        const identity = { id: managed.id, name: managed.name, room: managed.room };
        if (tool.name === "thermostat_status") {
          const plan = readPlan(input);
          const state = await withThermostat(connection, signal, authorize,
            (session) => session.exchange(plan.topic, plan.payload, plan.fields, plan.ready,
              { partial: plan.partial, acceptReport: plan.acceptReport }));
          const missing = plan.fields.filter((field) => !Object.hasOwn(state, field));
          return jsonResult({ ok: true, device: identity, state, ...(missing.length ? { missing } : {}) });
        }
        if (tool.name === "thermostat_control") {
          const { write, verify } = controlPlan(input);
          const state = await withThermostat(connection, signal, authorize, async (session) => {
            await session.send("set", write, true);
            return session.exchange(verify.topic, verify.payload, verify.fields, verify.ready, { acceptReport: verify.acceptReport });
          });
          return jsonResult({ ok: true, device: identity, state });
        }
        if (input.confirm !== true) throw new ThermostatError("invalid_request", "Valve calibration requires explicit confirmation.");
        const state = await withThermostat(connection, signal, authorize, async (session) => {
          const result = await session.exchange("set", { valve_travel_calibration: "calibrate" },
            ["motor_travel_calibration_status"], (state) =>
              state.motor_travel_calibration_status === "success" || state.motor_travel_calibration_status === "fail",
            { changesDevice: true });
          if (result.motor_travel_calibration_status === "fail") {
            throw new ThermostatError("device_calibration_failed", "The thermostat reported that valve calibration failed.");
          }
          return result;
        });
        return jsonResult({ ok: true, device: identity, state });
      } catch (error) {
        return jsonResult({ ok: false, error: error instanceof ThermostatError
          ? { code: error.code, message: error.message }
          : error instanceof DevicePolicyError && error.code === "device_denied"
            ? { code: "device_denied", message: "That thermostat is not available to this assistant." }
            : { code: "device_unavailable", message: "The assigned thermostat could not be reached." } });
      }
    },
  };
}

export default defineToolPlugin({
  id: provider, name, description, activation, configSchema: manifest.configSchema as never,
  tools: (register) => tools.map((definition) => register({
    name: definition.name, label: definition.label, description: definition.description,
    parameters: definition.parameters as never, optional: true,
    factory: ({ api, toolContext }) => toolFor(api, toolContext, definition),
  })),
});
