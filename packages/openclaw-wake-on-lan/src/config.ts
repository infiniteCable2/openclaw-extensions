import { isIPv4 } from "node:net";
import { WakeOnLanError } from "./errors.js";

export type WakeOnLanDevice = {
  id: string;
  macAddress: string;
  broadcastAddress: string;
  port: number;
};
export type WakeOnLanConfig = { devices: WakeOnLanDevice[]; requestTimeoutMs: number };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WakeOnLanError("invalid_config");
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new WakeOnLanError("invalid_config");
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new WakeOnLanError("invalid_config");
  return value;
}

export function normalizeMacAddress(value: unknown): string {
  if (typeof value !== "string" || value.length !== 17 || !/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value)) throw new WakeOnLanError("invalid_config");
  const bytes = Buffer.from(value.replaceAll(":", ""), "hex");
  if (bytes.every((byte) => byte === 0) || (bytes[0]! & 1) !== 0) throw new WakeOnLanError("invalid_config");
  return value.toLowerCase();
}

export function parseWakeOnLanConfig(raw: unknown): WakeOnLanConfig {
  const root = object(raw);
  keys(root, ["devices", "requestTimeoutMs"]);
  if (!Array.isArray(root.devices) || root.devices.length < 1 || root.devices.length > 128) throw new WakeOnLanError("invalid_config");
  const ids = new Set<string>();
  const macs = new Set<string>();
  const devices = root.devices.map((rawDevice): WakeOnLanDevice => {
    const device = object(rawDevice);
    keys(device, ["id", "macAddress", "broadcastAddress", "port"]);
    if (typeof device.id !== "string" || device.id.trim() !== device.id || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(device.id) || ids.has(device.id)) throw new WakeOnLanError("invalid_config");
    const macAddress = normalizeMacAddress(device.macAddress);
    if (macs.has(macAddress)) throw new WakeOnLanError("invalid_config");
    const broadcastAddress = device.broadcastAddress;
    if (typeof broadcastAddress !== "string" || !isIPv4(broadcastAddress) || !(broadcastAddress === "255.255.255.255" || /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(broadcastAddress))) throw new WakeOnLanError("invalid_config");
    ids.add(device.id);
    macs.add(macAddress);
    return { id: device.id, macAddress, broadcastAddress, port: integer(device.port, 9, 1, 65535) };
  });
  return { devices, requestTimeoutMs: integer(root.requestTimeoutMs, 2000, 100, 10000) };
}

/** Endpoints belong to the provider's current canonical config, never to tool arguments. */
export function wakeOnLanConfigFromOpenClawConfig(raw: unknown): WakeOnLanConfig {
  const entries = object(object(object(raw).plugins).entries);
  const provider = object(entries["wake-on-lan"]);
  if (provider.enabled === false) throw new WakeOnLanError("unavailable");
  return parseWakeOnLanConfig(provider.config);
}
