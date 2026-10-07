import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { assertDeviceGrant, authorizedDevices, type DeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import type { DabCatalogStore } from "./dab-catalog.js";
import type { DenonConfig } from "./config.js";
import { DenonCeolBackend } from "./denon.js";
import { LocalDeviceError, type LocalDeviceAction } from "./types.js";

export const statusSchema = { type: "object", additionalProperties: false, properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
} } satisfies AnyAgentTool["parameters"];
export const dabStationsSchema = { type: "object", additionalProperties: false, required: ["device"], properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
} } satisfies AnyAgentTool["parameters"];
export const controlSchema = { type: "object", additionalProperties: false, required: ["device", "action"], properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
  action: { type: "string", enum: ["turn_on", "turn_off", "set_volume", "set_mute", "select_source", "select_band", "station_next", "station_previous", "select_dab_station", "refresh_dab_stations", "tune_fm", "set_bass", "set_treble", "set_balance", "play", "pause", "stop", "track_next", "track_previous"] },
  volume: { type: "integer", minimum: 0, maximum: 60 }, muted: { type: "boolean" },
  source: { type: "string", enum: ["cd", "tuner", "optical1", "optical2", "analog"] },
  band: { type: "string", enum: ["dab", "fm"] },
  station: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
  frequencyMHz: { type: "number", minimum: 87.5, maximum: 108 },
  level: { type: "integer", minimum: -10, maximum: 10 }, balance: { type: "integer", minimum: -50, maximum: 50 },
  via: { type: "string", enum: ["telnet", "upnp", "heos"] },
} } satisfies AnyAgentTool["parameters"];

function parseAction(input: Record<string, unknown>): LocalDeviceAction {
  const integer = (key: string, min: number, max: number): number => {
    const value = input[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new LocalDeviceError("invalid_request", `${key} is invalid`);
    return value;
  };
  const choice = <T extends string>(key: string, values: readonly T[]): T => {
    const value = input[key];
    if (typeof value !== "string" || !values.includes(value as T)) throw new LocalDeviceError("invalid_request", `${key} is invalid`);
    return value as T;
  };
  const via = input.via === undefined ? undefined : choice("via", ["telnet", "upnp", "heos"] as const);
  switch (input.action) {
    case "turn_on": case "turn_off": case "station_next": case "station_previous": case "refresh_dab_stations":
    case "play": case "pause": case "stop": case "track_next": case "track_previous":
      if (via) throw new LocalDeviceError("invalid_request", "via is not supported for this action");
      return { type: input.action };
    case "set_volume":
      if (via === "heos") throw new LocalDeviceError("invalid_request", "via is not supported for volume");
      return { type: "set_volume", volume: integer("volume", 0, 60), via };
    case "set_mute":
      if (typeof input.muted !== "boolean") throw new LocalDeviceError("invalid_request", "muted is invalid");
      return { type: "set_mute", muted: input.muted, via };
    case "select_source":
      if (via === "upnp") throw new LocalDeviceError("invalid_request", "via is not supported for source");
      return { type: "select_source", source: choice("source", ["cd", "tuner", "optical1", "optical2", "analog"] as const), via };
    case "select_band":
      if (via === "heos") throw new LocalDeviceError("invalid_request", "via is not supported for band");
      return { type: "select_band", band: choice("band", ["dab", "fm"] as const), via };
    case "select_dab_station":
      if (via) throw new LocalDeviceError("invalid_request", "via is not supported for station");
      if (typeof input.station !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.station)) throw new LocalDeviceError("invalid_request", "station is invalid");
      return { type: "select_dab_station", station: input.station };
    case "tune_fm": {
      if (via) throw new LocalDeviceError("invalid_request", "via is not supported for FM tuning");
      const frequencyMHz = input.frequencyMHz;
      if (typeof frequencyMHz !== "number" || !Number.isFinite(frequencyMHz) || frequencyMHz < 87.5 || frequencyMHz > 108 || Math.abs(frequencyMHz * 10 - Math.round(frequencyMHz * 10)) > 1e-6) throw new LocalDeviceError("invalid_request", "frequencyMHz must use 0.1 MHz steps");
      return { type: "tune_fm", frequencyMHz };
    }
    case "set_bass": case "set_treble":
      if (via) throw new LocalDeviceError("invalid_request", "via is not supported for tone");
      return { type: input.action, level: integer("level", -10, 10) };
    case "set_balance":
      if (via) throw new LocalDeviceError("invalid_request", "via is not supported for balance");
      return { type: "set_balance", balance: integer("balance", -50, 50) };
    default: throw new LocalDeviceError("invalid_request", "Unsupported Denon action");
  }
}

export function buildDenonBackends(config: DenonConfig, registry: DeviceRegistry, catalogStore: DabCatalogStore): Map<string, DenonCeolBackend> {
  return new Map(config.devices.map((entry) => {
    const managed = registry.get(entry.id);
    if (!managed || managed.provider !== "denon") throw new Error(`Denon device ${entry.id} has no matching management entry`);
    return [entry.id, new DenonCeolBackend({ ...entry, name: managed.name }, config.requestTimeoutMs, catalogStore)] as const;
  }));
}

export function createDenonTools(config: DenonConfig, registry: DeviceRegistry, agentId: string, catalogStore: DabCatalogStore, currentRegistry: () => DeviceRegistry = () => registry, sharedBackends?: ReadonlyMap<string, DenonCeolBackend>): AnyAgentTool[] {
  const backends = sharedBackends ?? buildDenonBackends(config, registry, catalogStore);
  const permitted = () => authorizedDevices(currentRegistry(), agentId).filter((device) => device.provider === "denon" && device.grants.get(agentId)?.has("read") && backends.has(device.id));
  const failure = (error: unknown) => ({ ok: false, error: { code: error instanceof LocalDeviceError ? error.code : "device_denied" } });
  return [
    { name: "denon_status", label: "Denon Status", description: "Read assigned Denon receivers.", parameters: statusSchema,
      execute: async (_callId, params, signal) => {
        const input = params as { device?: string };
        const results = await Promise.all(permitted().filter((device) => !input.device || device.id === input.device).map(async (device) => {
          try { return await backends.get(device.id)!.status(signal); }
          catch { return { id: device.id, available: false, power: "unknown", error: { code: "device_unavailable" } }; }
        }));
        return jsonResult({ ok: true, devices: results });
      } },
    { name: "denon_dab_stations", label: "Denon DAB Stations", description: "Read cached station names without tuning. Duplicate names use scan-order labels but selection navigates to the next same-named station. If the cache is missing or stale, ask before an audible refresh_dab_stations scan of roughly two to four minutes.", parameters: dabStationsSchema,
      execute: async (_callId, params) => {
        try {
          const id = String((params as { device?: unknown }).device ?? "");
          assertDeviceGrant(currentRegistry(), agentId, id, "denon", "read");
          const backend = backends.get(id);
          if (!backend) throw new LocalDeviceError("unknown_device", "Denon device is not configured");
          return jsonResult({ ok: true, catalog: await backend.stationCatalog() });
        } catch (error) { return jsonResult(failure(error)); }
      } },
    { name: "denon_control", label: "Denon Control", description: "Control an assigned Denon receiver. Use denon_dab_stations before selecting a DAB station; an audible refresh requires user consent. via chooses an explicit interface when available.", parameters: controlSchema,
      execute: async (_callId, params, signal) => {
        try {
          const input = params as Record<string, unknown>;
          const id = String(input.device ?? "");
          assertDeviceGrant(currentRegistry(), agentId, id, "denon", "control");
          const backend = backends.get(id);
          if (!backend) throw new LocalDeviceError("unknown_device", "Denon device is not configured");
          return jsonResult({ ok: true, device: await backend.control(parseAction(input), signal) });
        } catch (error) { return jsonResult(failure(error)); }
      } },
  ];
}
