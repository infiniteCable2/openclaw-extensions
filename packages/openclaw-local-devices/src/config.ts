import { isIPv4 } from "node:net";
import {
  DEVICE_ID_PATTERN,
  LocalDeviceError,
  type FritzDeviceConfig,
  type GoveeDeviceConfig,
  type LocalDevicesConfig,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

function rejectUnknownKeys(record: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknown) {
    throw new LocalDeviceError("invalid_config", `${label}.${unknown} is not supported`);
  }
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalDeviceError("invalid_config", `${label} must be an object`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new LocalDeviceError("invalid_config", `${label} must be a non-empty string`);
  }
  return value;
}

function deviceId(value: unknown, label: string): string {
  const result = requiredString(value, label, 64);
  if (!DEVICE_ID_PATTERN.test(result)) {
    throw new LocalDeviceError("invalid_config", `${label} is not a valid device id`);
  }
  return result;
}

function displayName(value: unknown, fallback: string, label: string): string {
  return value === undefined ? fallback : requiredString(value, label, 80);
}

export function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) {
    return false;
  }
  const [first, second] = address.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function parseFritzBaseUrl(value: unknown): string {
  const raw = value === undefined ? "http://fritz.box" : requiredString(value, "fritz.baseUrl", 256);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LocalDeviceError("invalid_config", "fritz.baseUrl is not a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new LocalDeviceError("invalid_config", "fritz.baseUrl must be an HTTP(S) origin without credentials");
  }
  const hostAllowed = parsed.hostname.toLowerCase() === "fritz.box" || isPrivateIpv4(parsed.hostname);
  if (!hostAllowed || (parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash) {
    throw new LocalDeviceError("invalid_config", "fritz.baseUrl must identify a private FRITZ!Box origin");
  }
  return parsed.origin;
}

function parseGoveeDevices(value: unknown): GoveeDeviceConfig[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new LocalDeviceError("invalid_config", "govee.devices must contain between 1 and 16 devices");
  }
  return value.map((item, index) => {
    const record = asRecord(item, `govee.devices[${index}]`);
    rejectUnknownKeys(record, ["id", "name", "address"], `govee.devices[${index}]`);
    const id = deviceId(record.id, `govee.devices[${index}].id`);
    const address = requiredString(record.address, `govee.devices[${index}].address`, 15);
    if (!isPrivateIpv4(address)) {
      throw new LocalDeviceError("invalid_config", `govee.devices[${index}].address must be a private IPv4 address`);
    }
    return {
      id,
      name: displayName(record.name, id, `govee.devices[${index}].name`),
      address,
    };
  });
}

function parseFritzDevices(value: unknown): FritzDeviceConfig[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new LocalDeviceError("invalid_config", "fritz.devices must contain between 1 and 16 devices");
  }
  return value.map((item, index) => {
    const record = asRecord(item, `fritz.devices[${index}]`);
    rejectUnknownKeys(record, ["id", "name", "uid"], `fritz.devices[${index}]`);
    const id = deviceId(record.id, `fritz.devices[${index}].id`);
    return {
      id,
      name: displayName(record.name, id, `fritz.devices[${index}].name`),
      uid: requiredString(record.uid, `fritz.devices[${index}].uid`, 80),
    };
  });
}

function rejectDuplicateIds(config: LocalDevicesConfig): void {
  const ids = [
    ...(config.govee?.devices.map((device) => device.id) ?? []),
    ...(config.fritz?.devices.map((device) => device.id) ?? []),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new LocalDeviceError("invalid_config", "device ids must be unique across providers");
  }
  const goveeAddresses = config.govee?.devices.map((device) => device.address) ?? [];
  if (new Set(goveeAddresses).size !== goveeAddresses.length) {
    throw new LocalDeviceError("invalid_config", "Govee device addresses must be unique");
  }
}

export function parseLocalDevicesConfig(value: unknown): LocalDevicesConfig {
  const root = asRecord(value, "plugin config");
  rejectUnknownKeys(root, ["allowedAgentIds", "requestTimeoutMs", "govee", "fritz"], "plugin config");
  if (!Array.isArray(root.allowedAgentIds) || root.allowedAgentIds.length < 1 || root.allowedAgentIds.length > 16) {
    throw new LocalDeviceError("invalid_config", "allowedAgentIds must contain between 1 and 16 agent ids");
  }
  const agents = root.allowedAgentIds.map((value, index) => deviceId(value, `allowedAgentIds[${index}]`));
  if (new Set(agents).size !== agents.length) {
    throw new LocalDeviceError("invalid_config", "allowedAgentIds must be unique");
  }
  const requestTimeoutMs = root.requestTimeoutMs === undefined ? 5000 : root.requestTimeoutMs;
  if (!Number.isInteger(requestTimeoutMs) || Number(requestTimeoutMs) < 500 || Number(requestTimeoutMs) > 15000) {
    throw new LocalDeviceError("invalid_config", "requestTimeoutMs must be an integer between 500 and 15000");
  }
  const parsed: LocalDevicesConfig = {
    allowedAgentIds: new Set(agents),
    requestTimeoutMs: Number(requestTimeoutMs),
  };
  if (root.govee !== undefined) {
    const govee = asRecord(root.govee, "govee");
    rejectUnknownKeys(govee, ["devices"], "govee");
    parsed.govee = { devices: parseGoveeDevices(govee.devices) };
  }
  if (root.fritz !== undefined) {
    const fritz = asRecord(root.fritz, "fritz");
    rejectUnknownKeys(fritz, ["baseUrl", "username", "password", "devices"], "fritz");
    parsed.fritz = {
      baseUrl: parseFritzBaseUrl(fritz.baseUrl),
      username: requiredString(fritz.username, "fritz.username", 128),
      password: requiredString(fritz.password, "fritz.password", 1024),
      devices: parseFritzDevices(fritz.devices),
    };
  }
  if (!parsed.govee && !parsed.fritz) {
    throw new LocalDeviceError("invalid_config", "at least one device provider must be configured");
  }
  rejectDuplicateIds(parsed);
  const deviceCount = (parsed.govee?.devices.length ?? 0) + (parsed.fritz?.devices.length ?? 0);
  if (deviceCount > 16) {
    throw new LocalDeviceError("invalid_config", "at most 16 devices may be configured across all providers");
  }
  return parsed;
}
