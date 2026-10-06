import { isIPv4 } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type TvApp = { id: string; name: string; via: "remote" | "adb"; locator: string };
export type TvDevice = {
  id: string;
  name: string;
  host: string;
  remoteCertPath: string;
  remoteKeyPath: string;
  wake?: { macAddress: string; broadcastAddress: string };
  adb?: { path: string; home: string; serial: string; serverPort: number };
  apps: TvApp[];
};
export type TvConfig = {
  allowedAgentIds: Set<string>;
  pythonPath: string;
  recipeDirectory?: string;
  requestTimeoutMs: number;
  powerOnTimeoutMs: number;
  screenshotDirectory: string;
  screenshotMaxAgeSeconds: number;
  devices: Map<string, TvDevice>;
};

const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}
function id(value: unknown, name: string): string {
  const result = string(value, name);
  if (!idPattern.test(result)) throw new Error(`${name} is invalid`);
  return result;
}

function privateIPv4(value: unknown, name: string): string {
  const address = string(value, name);
  if (!isIPv4(address) || !(address.startsWith("192.168.") || address.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address))) {
    throw new Error(`${name} must be a private IPv4 address`);
  }
  return address;
}

export function parseTvConfig(raw: unknown): TvConfig {
  const input = object(raw, "config");
  const agents = input.allowedAgentIds;
  if (!Array.isArray(agents) || agents.length < 1 || agents.length > 16) throw new Error("allowedAgentIds must be a nonempty array");
  const allowedAgentIds = new Set(agents.map((value) => id(value, "agent id")));
  if (allowedAgentIds.size !== agents.length) throw new Error("duplicate agent id");
  const listed = input.devices;
  if (!Array.isArray(listed) || listed.length < 1 || listed.length > 4) throw new Error("devices must contain 1-4 entries");
  const devices = new Map<string, TvDevice>();
  for (const item of listed) {
    const device = object(item, "device");
    const deviceId = id(device.id, "device id");
    const host = privateIPv4(device.host, "device host");
    if (devices.has(deviceId)) throw new Error("duplicate device id");
    let wake: TvDevice["wake"];
    if (device.wake !== undefined) {
      const value = object(device.wake, "wake");
      const macAddress = string(value.macAddress, "wake.macAddress").toLowerCase();
      if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(macAddress) || (parseInt(macAddress.slice(0, 2), 16) & 1) !== 0) {
        throw new Error("wake.macAddress must be a unicast MAC address");
      }
      const broadcastAddress = privateIPv4(value.broadcastAddress, "wake.broadcastAddress");
      if (broadcastAddress === host) throw new Error("wake.broadcastAddress must differ from device host");
      wake = { macAddress, broadcastAddress };
    }
    let adb: TvDevice["adb"];
    if (device.adb !== undefined) {
      const value = object(device.adb, "adb");
      const serverPort = value.serverPort === undefined ? 5038 : Number(value.serverPort);
      if (!Number.isInteger(serverPort) || serverPort < 1024 || serverPort > 65535) throw new Error("invalid adb serverPort");
      adb = { path: string(value.path, "adb.path"), home: string(value.home, "adb.home"), serial: string(value.serial, "adb.serial"), serverPort };
    }
    const apps = new Array<TvApp>();
    for (const appRaw of Array.isArray(device.apps) ? device.apps : []) {
      const app = object(appRaw, "app");
      const via = app.via;
      if (via !== "remote" && via !== "adb") throw new Error("app.via must be remote or adb");
      if (via === "adb" && !adb) throw new Error("ADB app requires configured ADB");
      apps.push({ id: id(app.id, "app id"), name: string(app.name, "app name"), via, locator: string(app.locator, "app locator") });
    }
    if (new Set(apps.map((app) => app.id)).size !== apps.length) throw new Error("duplicate app id");
    devices.set(deviceId, { id: deviceId, name: string(device.name, "device name"), host, remoteCertPath: string(device.remoteCertPath, "cert path"), remoteKeyPath: string(device.remoteKeyPath, "key path"), wake, adb, apps });
  }
  const requestTimeoutMs = input.requestTimeoutMs === undefined ? 15000 : Number(input.requestTimeoutMs);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 30000) throw new Error("invalid requestTimeoutMs");
  const powerOnTimeoutMs = input.powerOnTimeoutMs === undefined ? 30000 : Number(input.powerOnTimeoutMs);
  if (!Number.isInteger(powerOnTimeoutMs) || powerOnTimeoutMs < 12000 || powerOnTimeoutMs > 45000) throw new Error("invalid powerOnTimeoutMs");
  const screenshotDirectory = input.screenshotDirectory === undefined
    ? join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "media", "google-tv")
    : string(input.screenshotDirectory, "screenshotDirectory");
  if (!isAbsolute(screenshotDirectory)) throw new Error("screenshotDirectory must be absolute");
  const screenshotMaxAgeSeconds = input.screenshotMaxAgeSeconds === undefined ? 900 : Number(input.screenshotMaxAgeSeconds);
  if (!Number.isInteger(screenshotMaxAgeSeconds) || screenshotMaxAgeSeconds < 60 || screenshotMaxAgeSeconds > 86400) throw new Error("invalid screenshotMaxAgeSeconds");
  return { allowedAgentIds, pythonPath: string(input.pythonPath, "pythonPath"), recipeDirectory: input.recipeDirectory === undefined ? undefined : string(input.recipeDirectory, "recipeDirectory"), requestTimeoutMs, powerOnTimeoutMs, screenshotDirectory, screenshotMaxAgeSeconds, devices };
}
