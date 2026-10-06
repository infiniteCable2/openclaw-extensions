import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { FritzSmartHomeBackend } from "./fritz.js";
import { DenonCeolBackend } from "./denon.js";
import type { DabCatalogStore } from "./dab-catalog.js";
import { GoveeLanBackend, GoveeLanStatusCoordinator, readGoveeStatuses } from "./govee.js";
import type { DeviceBackend, DeviceStatus, LocalDeviceAction, LocalDevicesConfig } from "./types.js";
import { LocalDeviceError } from "./types.js";

export const statusSchema = {
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

export const dabStationsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["device"],
  properties: {
    device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
  },
} satisfies AnyAgentTool["parameters"];

export const controlSchema = {
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
      enum: ["turn_on", "turn_off", "set_brightness", "set_color", "set_color_temperature", "set_volume", "set_mute", "select_source", "select_band", "station_next", "station_previous", "select_dab_station", "refresh_dab_stations", "tune_fm", "set_bass", "set_treble", "set_balance", "play", "pause", "stop", "track_next", "track_previous"],
    },
    brightness: { type: "integer", minimum: 1, maximum: 100 },
    red: { type: "integer", minimum: 0, maximum: 255 },
    green: { type: "integer", minimum: 0, maximum: 255 },
    blue: { type: "integer", minimum: 0, maximum: 255 },
    kelvin: { type: "integer", minimum: 2000, maximum: 9000 },
    volume: { type: "integer", minimum: 0, maximum: 60 },
    muted: { type: "boolean" },
    source: { type: "string", enum: ["cd", "tuner", "optical1", "optical2", "analog"] },
    band: { type: "string", enum: ["dab", "fm"] },
    station: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
    frequencyMHz: { type: "number", minimum: 87.5, maximum: 108 },
    level: { type: "integer", minimum: -10, maximum: 10 },
    balance: { type: "integer", minimum: -50, maximum: 50 },
    via: { type: "string", enum: ["telnet", "upnp", "heos"] },
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

function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new LocalDeviceError("invalid_request", `${label} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function selectedMethod(value: unknown): "telnet" | "upnp" | "heos" | undefined {
  return value === undefined ? undefined : choice(value, ["telnet", "upnp", "heos"] as const, "via");
}

function actionMethod<T extends "telnet" | "upnp" | "heos">(
  value: "telnet" | "upnp" | "heos" | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new LocalDeviceError("invalid_request", `via must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseDeviceAction(raw: unknown): LocalDeviceAction {
  const params = record(raw);
  const via = selectedMethod(params.via);
  if (via !== undefined && !["set_volume", "set_mute", "select_source", "select_band"].includes(String(params.action))) {
    throw new LocalDeviceError("invalid_request", "via is not supported for this action");
  }
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
    case "set_volume":
      return { type: "set_volume", volume: integer(params.volume, "volume", 0, 60), via: actionMethod(via, ["telnet", "upnp"]) };
    case "set_mute":
      if (typeof params.muted !== "boolean") throw new LocalDeviceError("invalid_request", "muted must be a boolean");
      return { type: "set_mute", muted: params.muted, via: actionMethod(via, ["telnet", "upnp", "heos"]) };
    case "select_source":
      return { type: "select_source", source: choice(params.source, ["cd", "tuner", "optical1", "optical2", "analog"], "source"), via: actionMethod(via, ["heos", "telnet"]) };
    case "select_band":
      return { type: "select_band", band: choice(params.band, ["dab", "fm"], "band"), via: actionMethod(via, ["telnet", "upnp"]) };
    case "station_next":
    case "station_previous":
    case "refresh_dab_stations":
    case "play":
    case "pause":
    case "stop":
    case "track_next":
    case "track_previous":
      return { type: params.action };
    case "select_dab_station":
      if (typeof params.station !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(params.station)) {
        throw new LocalDeviceError("invalid_request", "station must be a configured station id");
      }
      return { type: "select_dab_station", station: params.station };
    case "tune_fm":
      if (typeof params.frequencyMHz !== "number" || !Number.isFinite(params.frequencyMHz) || params.frequencyMHz < 87.5 || params.frequencyMHz > 108) {
        throw new LocalDeviceError("invalid_request", "frequencyMHz must be an FM frequency from 87.5 to 108 in 0.1 MHz steps");
      }
      if (Math.abs(params.frequencyMHz * 10 - Math.round(params.frequencyMHz * 10)) > 1e-6) {
        throw new LocalDeviceError("invalid_request", "frequencyMHz must use 0.1 MHz steps");
      }
      return { type: "tune_fm", frequencyMHz: params.frequencyMHz };
    case "set_bass":
    case "set_treble":
      return { type: params.action, level: integer(params.level, "level", -10, 10) };
    case "set_balance":
      return { type: "set_balance", balance: integer(params.balance, "balance", -50, 50) };
    default:
      throw new LocalDeviceError("invalid_request", "action is not supported");
  }
}

export function buildBackends(config: LocalDevicesConfig, dabCatalogStore: DabCatalogStore): Map<string, DeviceBackend> {
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
  for (const device of config.denon?.devices ?? []) {
    backends.set(device.id, new DenonCeolBackend(device, config.requestTimeoutMs, dabCatalogStore));
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
      "Read configured local lights, sockets and Denon receivers, including receiver capabilities and interface alternatives. Never discovers arbitrary LAN hosts.",
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

  const dabStationsTool: AnyAgentTool = {
    name: "local_device_dab_stations",
    label: "DAB Station List",
    description:
      "Read the receiver's cached DAB station names without retuning it. New scans give equal names scan-order display labels _2, _3, etc.; old caches may show one repeated-name entry until refreshed. These are not proven service IDs. Selecting one navigates to the next station with that name, not necessarily that exact labeled occurrence. If missing or stale, explain that refresh audibly cycles stations for roughly two to four minutes; ask the user before invoking refresh_dab_stations. Never refresh as part of a read request.",
    parameters: dabStationsSchema,
    executionMode: "sequential",
    execute: async (_toolCallId, rawParams) => {
      try {
        const deviceId = record(rawParams).device;
        if (typeof deviceId !== "string") throw new LocalDeviceError("invalid_request", "device must be a configured receiver id");
        const backend = backends.get(deviceId);
        if (!backend) throw new LocalDeviceError("unknown_device", "Configured device was not found");
        if (!(backend instanceof DenonCeolBackend)) throw new LocalDeviceError("unsupported_action", "Device has no DAB station list");
        return jsonResult({ ok: true, catalog: await backend.stationCatalog() });
      } catch (error) {
        return jsonResult({ ok: false, error: safeError(error) });
      }
    },
  };

  const controlTool: AnyAgentTool = {
    name: "local_device_control",
    label: "Local Device Control",
    description:
      "Control a configured local light, socket or Denon CEOL receiver. For DAB station selection, first read local_device_dab_stations and use a selectable station id. Duplicate labels navigate to the next same-named station in the shorter cached direction; the exact duplicate remains unverified (dabSelection.confirmed=false). dabStep.confirmed=false means a single step was not proven. refresh_dab_stations audibly cycles stations for roughly two to four minutes: ask for consent first; it requires active DAB playback. If selection reports dab_catalog_stale, propose another refresh. Never scan automatically on a status read. via selects an explicit interface when available.",
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

  return [statusTool, dabStationsTool, controlTool];
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
