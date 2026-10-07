import { isIPv4 } from "node:net";
import type { FritzDeviceConfig } from "./types.js";

export type FritzConfig = { baseUrl: string; username: string; password: string; devices: FritzDeviceConfig[]; requestTimeoutMs: number };

export function parseFritzConfig(raw: unknown): FritzConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("FRITZ config must be an object");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["baseUrl", "username", "password", "devices", "requestTimeoutMs"].includes(key))) throw new Error("FRITZ config has an unknown field");
  const baseUrl = input.baseUrl === undefined ? "http://fritz.box" : input.baseUrl;
  if (typeof baseUrl !== "string") throw new Error("FRITZ baseUrl is invalid");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("FRITZ baseUrl is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(
    url.hostname === "fritz.box" || (isIPv4(url.hostname) && /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(url.hostname))
  )) throw new Error("FRITZ baseUrl must be a private origin without credentials");
  if (typeof input.username !== "string" || !input.username || input.username.length > 128) throw new Error("FRITZ username is invalid");
  if (typeof input.password !== "string" || !input.password || input.password.length > 1024) throw new Error("FRITZ password is invalid");
  if (!Array.isArray(input.devices) || input.devices.length < 1 || input.devices.length > 16) throw new Error("FRITZ devices must contain 1-16 entries");
  const ids = new Set<string>();
  const devices = input.devices.map((rawDevice): FritzDeviceConfig => {
    if (!rawDevice || typeof rawDevice !== "object" || Array.isArray(rawDevice)) throw new Error("FRITZ device must be an object");
    const device = rawDevice as Record<string, unknown>;
    if (Object.keys(device).some((key) => !["id", "uid"].includes(key))) throw new Error("FRITZ device has an unknown field");
    if (typeof device.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(device.id) || ids.has(device.id)) throw new Error("FRITZ device id is invalid or duplicate");
    if (typeof device.uid !== "string" || !device.uid || device.uid.length > 80) throw new Error("FRITZ device uid is invalid");
    ids.add(device.id);
    return { id: device.id, name: device.id, uid: device.uid };
  });
  const requestTimeoutMs = input.requestTimeoutMs === undefined ? 5000 : Number(input.requestTimeoutMs);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 500 || requestTimeoutMs > 15000) throw new Error("FRITZ requestTimeoutMs is invalid");
  return { baseUrl: url.origin, username: input.username, password: input.password, devices, requestTimeoutMs };
}
