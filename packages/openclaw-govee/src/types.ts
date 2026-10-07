export type GoveeDeviceConfig = { id: string; name: string; address: string };
export type DeviceAction =
  | { type: "turn_on" | "turn_off" }
  | { type: "set_brightness"; brightness: number }
  | { type: "set_color"; red: number; green: number; blue: number }
  | { type: "set_color_temperature"; kelvin: number };
export type LocalDeviceAction = DeviceAction;
export type DeviceStatus = {
  id: string; name: string; provider: "govee"; available: boolean; power: "on" | "off" | "unknown";
  brightness?: number; color?: { red: number; green: number; blue: number }; colorTemperatureKelvin?: number;
};
export interface DeviceBackend {
  readonly provider: "govee";
  status(signal?: AbortSignal): Promise<DeviceStatus>;
  control(action: LocalDeviceAction, signal?: AbortSignal): Promise<DeviceStatus>;
}
export class LocalDeviceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalDeviceError"; }
}
