import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { FritzSmartHomeBackend } from "./fritz.js";
import { GoveeLanBackend, GoveeLanStatusCoordinator, readGoveeStatuses } from "./govee.js";
import type { DeviceAction, DeviceBackend, DeviceStatus, LocalDevicesConfig } from "./types.js";
import { LocalDeviceError } from "./types.js";

const statusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    device: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
      description: "Configured device id. Omit to read every configured device.",
    },
  },
} satisfies AnyAgentTool["parameters"];

const controlSchema = {
  type: "object",
  additionalProperties: false,
  required: ["device", "action"],
  properties: {
    device: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
      description: "Configured device id.",
    },
    action: {
      type: "string",
      enum: ["turn_on", "turn_off", "set_brightness", "set_color", "set_color_temperature"],
    },
    brightness: { type: "integer", minimum: 1, maximum: 100 },
    red: { type: "integer", minimum: 0, maximum: 255 },
    green: { type: "integer", minimum: 0, maximum: 255 },
    blue: { type: "integer", minimum: 0, maximum: 255 },
    kelvin: { type: "integer", minimum: 2000, maximum: 9000 },
  },
} satisfies AnyAgentTool["parameters"];

type StatusError = {
  id: string;
  available: false;
  power: "unknown";
  error: { code: string; message: string };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new LocalDeviceError(
      "invalid_request",
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

export function parseDeviceAction(raw: unknown): DeviceAction {
  const params = record(raw);
  switch (params.action) {
    case "turn_on":
      return { type: "turn_on" };
    case "turn_off":
      return { type: "turn_off" };
    case "set_brightness":
      return {
        type: "set_brightness",
        brightness: integer(params.brightness, "brightness", 1, 100),
      };
    case "set_color":
      return {
        type: "set_color",
        red: integer(params.red, "red", 0, 255),
        green: integer(params.green, "green", 0, 255),
        blue: integer(params.blue, "blue", 0, 255),
      };
    case "set_color_temperature":
      return {
        type: "set_color_temperature",
        kelvin: integer(params.kelvin, "kelvin", 2000, 9000),
      };
    default:
      throw new LocalDeviceError("invalid_request", "action is not supported");
  }
}

export function buildBackends(config: LocalDevicesConfig): Map<string, DeviceBackend> {
  const backends = new Map<string, DeviceBackend>();
  const goveeStatusCoordinator = new GoveeLanStatusCoordinator();
  for (const device of config.govee?.devices ?? []) {
    backends.set(
      device.id,
      new GoveeLanBackend(device, config.requestTimeoutMs, undefined, goveeStatusCoordinator),
    );
  }
  for (const device of config.fritz?.devices ?? []) {
    backends.set(
      device.id,
      new FritzSmartHomeBackend(
        device,
        config.fritz!.baseUrl,
        config.fritz!.username,
        config.fritz!.password,
        config.requestTimeoutMs,
      ),
    );
  }
  return backends;
}

function safeError(error: unknown): { code: string; message: string } {
  return error instanceof LocalDeviceError
    ? { code: error.code, message: error.message }
    : { code: "device_unavailable", message: "Local device request failed" };
}

async function readSelectedStatuses(
  selected: ReadonlyArray<readonly [string, DeviceBackend | undefined]>,
  signal?: AbortSignal,
): Promise<Array<DeviceStatus | StatusError>> {
  const results = new Map<string, DeviceStatus | StatusError>();
  const govee = selected
    .map(([, backend]) => backend)
    .filter((backend): backend is GoveeLanBackend => backend instanceof GoveeLanBackend);

  const goveeOperation =
    govee.length === 0
      ? Promise.resolve()
      : readGoveeStatuses(govee, signal).then(
          (statuses) => {
            for (const [id, status] of statuses) {
              results.set(id, status);
            }
          },
          (error: unknown) => {
            for (const backend of govee) {
              const id = backend.configuredDevice.id;
              results.set(id, { id, available: false, power: "unknown", error: safeError(error) });
            }
          },
        );

  const otherOperations = selected
    .filter(([, backend]) => backend && !(backend instanceof GoveeLanBackend))
    .map(async ([id, backend]) => {
      try {
        results.set(id, await backend!.status(signal));
      } catch (error) {
        results.set(id, { id, available: false, power: "unknown", error: safeError(error) });
      }
    });
  await Promise.all([goveeOperation, ...otherOperations]);
  return selected.flatMap(([id]) => {
    const result = results.get(id);
    return result ? [result] : [];
  });
}

export function createLocalDeviceTools(backends: ReadonlyMap<string, DeviceBackend>): AnyAgentTool[] {
  const statusTool: AnyAgentTool = {
    name: "local_device_status",
    label: "Local Device Status",
    description:
      "Read the current state of configured local Govee lights and FRITZ! Smart Home devices. Never discovers arbitrary LAN hosts.",
    parameters: statusSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams, signal) => {
      const requested = record(rawParams).device;
      if (requested !== undefined && typeof requested !== "string") {
        return jsonResult({
          ok: false,
          error: { code: "invalid_request", message: "device must be a string" },
        });
      }
      const selected = requested
        ? ([[requested, backends.get(requested)]] as const)
        : [...backends.entries()];
      if (requested && !selected[0]?.[1]) {
        return jsonResult({
          ok: false,
          error: { code: "unknown_device", message: "Configured device was not found" },
        });
      }
      return jsonResult({ ok: true, devices: await readSelectedStatuses(selected, signal) });
    },
  };

  const controlTool: AnyAgentTool = {
    name: "local_device_control",
    label: "Local Device Control",
    description:
      "Control one configured local light or socket. Supports power for all devices and brightness, RGB color, or color temperature only for Govee lights.",
    parameters: controlSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams, signal) => {
      try {
        const params = record(rawParams);
        const deviceId = typeof params.device === "string" ? params.device : "";
        const backend = backends.get(deviceId);
        if (!backend) {
          throw new LocalDeviceError("unknown_device", "Configured device was not found");
        }
        const device = await backend.control(parseDeviceAction(params), signal);
        return jsonResult({ ok: true, device });
      } catch (error) {
        return jsonResult({ ok: false, error: safeError(error) });
      }
    },
  };

  return [statusTool, controlTool];
}

export function createToolsForAgent(
  config: LocalDevicesConfig,
  backends: ReadonlyMap<string, DeviceBackend>,
  agentId: string | undefined,
): AnyAgentTool[] | null {
  return agentId && config.allowedAgentIds.has(agentId)
    ? createLocalDeviceTools(backends)
    : null;
}
