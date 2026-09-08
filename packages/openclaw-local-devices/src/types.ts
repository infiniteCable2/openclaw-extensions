export const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type GoveeDeviceConfig = {
  id: string;
  name: string;
  address: string;
};

export type FritzDeviceConfig = {
  id: string;
  name: string;
  uid: string;
};

export type LocalDevicesConfig = {
  allowedAgentIds: ReadonlySet<string>;
  requestTimeoutMs: number;
  govee?: {
    devices: readonly GoveeDeviceConfig[];
  };
  fritz?: {
    baseUrl: string;
    username: string;
    password: string;
    devices: readonly FritzDeviceConfig[];
  };
};

export type DeviceStatus = {
  id: string;
  name: string;
  provider: "govee" | "fritz";
  available: boolean;
  power: "on" | "off" | "unknown";
  brightness?: number;
  color?: { red: number; green: number; blue: number };
  colorTemperatureKelvin?: number;
  powerWatts?: number;
};

export type DeviceAction =
  | { type: "turn_on" }
  | { type: "turn_off" }
  | { type: "set_brightness"; brightness: number }
  | { type: "set_color"; red: number; green: number; blue: number }
  | { type: "set_color_temperature"; kelvin: number };

export interface DeviceBackend {
  readonly provider: DeviceStatus["provider"];
  status(signal?: AbortSignal): Promise<DeviceStatus>;
  control(action: DeviceAction, signal?: AbortSignal): Promise<DeviceStatus>;
}

export class LocalDeviceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalDeviceError";
  }
}
