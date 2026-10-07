export type FritzDeviceConfig = { id: string; name: string; uid: string };
export type LocalDeviceAction = { type: "turn_on" | "turn_off" } | { type: "set_brightness"; brightness: number };
export type DeviceStatus = {
  id: string; name: string; provider: "fritz"; available: boolean; power: "on" | "off" | "unknown";
  powerWatts?: number;
};
export interface DeviceBackend {
  readonly provider: "fritz";
  status(signal?: AbortSignal): Promise<DeviceStatus>;
  control(action: LocalDeviceAction, signal?: AbortSignal): Promise<DeviceStatus>;
}
export class LocalDeviceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalDeviceError"; }
}
