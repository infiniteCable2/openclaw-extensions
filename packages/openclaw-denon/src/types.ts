export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export type DenonDeviceConfig = { id: string; name: string; address: string };
export type LocalDeviceAction =
  | { type: "turn_on" | "turn_off" }
  | { type: "set_volume"; volume: number; via?: "telnet" | "upnp" }
  | { type: "set_mute"; muted: boolean; via?: "telnet" | "upnp" | "heos" }
  | { type: "select_source"; source: "cd" | "tuner" | "optical1" | "optical2" | "analog"; via?: "heos" | "telnet" }
  | { type: "select_band"; band: "dab" | "fm"; via?: "telnet" | "upnp" }
  | { type: "station_next" | "station_previous" | "refresh_dab_stations" }
  | { type: "select_dab_station"; station: string }
  | { type: "tune_fm"; frequencyMHz: number }
  | { type: "set_bass" | "set_treble"; level: number }
  | { type: "set_balance"; balance: number }
  | { type: "play" | "pause" | "stop" | "track_next" | "track_previous" };
export type DeviceStatus = {
  id: string; name: string; provider: "denon"; available: boolean; power: "on" | "off" | "unknown";
  receiver?: {
    volume?: number; muted?: boolean; source?: string; band?: "dab" | "fm"; station?: string;
    dabChannel?: string; fmFrequencyMHz?: number;
    dabStep?: { direction: "next" | "previous"; confirmed: boolean };
    dabSelection?: { stationId: string; label: string; direction: "next" | "previous"; steps: number; confirmed: boolean; method: "relative" };
    bass?: number; treble?: number; balance?: number; sources: readonly string[];
    playback?: "play" | "pause" | "stop";
    dabCatalog: { state: "missing" | "scanning" | "ready" | "partial" | "stale" | "unavailable"; stationCount: number; scannedAt?: number; uncertainSteps?: number; guidance?: string };
    alternatives: Readonly<Record<string, readonly string[]>>;
  };
};
export interface DeviceBackend {
  readonly provider: "denon";
  status(signal?: AbortSignal): Promise<DeviceStatus>;
  control(action: LocalDeviceAction, signal?: AbortSignal): Promise<DeviceStatus>;
}
export class LocalDeviceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalDeviceError"; }
}
