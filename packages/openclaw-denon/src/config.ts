import { isIPv4 } from "node:net";
import type { DenonDeviceConfig } from "./types.js";

export type DenonConfig = { devices: DenonDeviceConfig[]; requestTimeoutMs: number };

export function parseDenonConfig(raw: unknown): DenonConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Denon config must be an object");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["devices", "requestTimeoutMs"].includes(key))) throw new Error("Denon config has an unknown field");
  if (!Array.isArray(input.devices) || input.devices.length < 1 || input.devices.length > 16) throw new Error("Denon devices must contain 1-16 entries");
  const ids = new Set<string>();
  const addresses = new Set<string>();
  const devices = input.devices.map((rawDevice): DenonDeviceConfig => {
    if (!rawDevice || typeof rawDevice !== "object" || Array.isArray(rawDevice)) throw new Error("Denon device must be an object");
    const device = rawDevice as Record<string, unknown>;
    if (Object.keys(device).some((key) => !["id", "address"].includes(key))) throw new Error("Denon device has an unknown field");
    if (typeof device.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(device.id) || ids.has(device.id)) throw new Error("Denon device id is invalid or duplicate");
    if (typeof device.address !== "string" || !isIPv4(device.address) || !/^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(device.address) || addresses.has(device.address)) throw new Error("Denon address must be a unique private IPv4 address");
    ids.add(device.id); addresses.add(device.address);
    return { id: device.id, name: device.id, address: device.address };
  });
  const requestTimeoutMs = input.requestTimeoutMs === undefined ? 5000 : Number(input.requestTimeoutMs);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 500 || requestTimeoutMs > 15000) throw new Error("Denon requestTimeoutMs is invalid");
  return { devices, requestTimeoutMs };
}
