import { isIPv4 } from "node:net";

export type TvApp = { id: string; name: string; via: "remote" | "adb"; locator: string };
export type TvDevice = {
  id: string;
  name: string;
  host: string;
  remoteCertPath: string;
  remoteKeyPath: string;
  adb?: { path: string; home: string; serial: string; serverPort: number };
  apps: TvApp[];
};
export type TvConfig = {
  allowedAgentIds: Set<string>;
  pythonPath: string;
  recipeDirectory?: string;
  requestTimeoutMs: number;
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
    const host = string(device.host, "device host");
    if (!isIPv4(host) || !(host.startsWith("192.168.") || host.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host))) {
      throw new Error("device host must be a private IPv4 address");
    }
    if (devices.has(deviceId)) throw new Error("duplicate device id");
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
    devices.set(deviceId, { id: deviceId, name: string(device.name, "device name"), host, remoteCertPath: string(device.remoteCertPath, "cert path"), remoteKeyPath: string(device.remoteKeyPath, "key path"), adb, apps });
  }
  const requestTimeoutMs = input.requestTimeoutMs === undefined ? 15000 : Number(input.requestTimeoutMs);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 30000) throw new Error("invalid requestTimeoutMs");
  return { allowedAgentIds, pythonPath: string(input.pythonPath, "pythonPath"), recipeDirectory: input.recipeDirectory === undefined ? undefined : string(input.recipeDirectory, "recipeDirectory"), requestTimeoutMs, devices };
}
