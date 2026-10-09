import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The single owner of device identity, location, presentation and agent grants. */
export type DevicePermission = "read" | "control" | "observe" | "guide";
export type DeviceKind = "light" | "switch" | "media_receiver" | "television" | "computer";

export type ManagedDevice = {
  id: string;
  name: string;
  kind: DeviceKind;
  siteId: string;
  room: string;
  provider: string;
  capabilities: readonly string[];
  tools: Readonly<Partial<Record<"status" | "control" | "observe" | "guide" | "stations", string>>>;
  grants: ReadonlyMap<string, ReadonlySet<DevicePermission>>;
};

export type DeviceRegistry = ReadonlyMap<string, ManagedDevice>;
export type DeviceProviderMetadata = Pick<ManagedDevice, "capabilities" | "tools">;

const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const toolPattern = /^[a-z][a-z0-9_]*$/;
const kinds = new Set<DeviceKind>(["light", "switch", "media_receiver", "television", "computer"]);
const permissions = new Set<DevicePermission>(["read", "control", "observe", "guide"]);

export class DevicePolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DevicePolicyError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DevicePolicyError("invalid_config", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new DevicePolicyError("invalid_config", `${label}.${unknown} is not supported`);
}

function string(value: unknown, label: string, maxLength = 80): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maxLength) {
    throw new DevicePolicyError("invalid_config", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function id(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!idPattern.test(result)) throw new DevicePolicyError("invalid_config", `${label} is invalid`);
  return result;
}

function tool(value: unknown, label: string): string {
  const result = string(value, label, 128);
  if (!toolPattern.test(result)) throw new DevicePolicyError("invalid_config", `${label} is invalid`);
  return result;
}

/** Plugin-owned data only: never imports or executes a configured module. */
export function loadProviderMetadata(provider: string, packageRoot: string): DeviceProviderMetadata {
  if (!isAbsolute(packageRoot)) throw new DevicePolicyError("invalid_config", `Provider ${provider} requires an absolute package directory`);
  const readJson = (name: string, limit: number): Record<string, unknown> => {
    try {
      const path = join(packageRoot, name);
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > limit) throw new Error("invalid metadata file");
      return object(JSON.parse(readFileSync(path, "utf8")), name);
    } catch {
      throw new DevicePolicyError("invalid_config", `Provider ${provider} has unavailable or invalid ${name}`);
    }
  };
  const metadata = readJson("device-provider.json", 64 * 1024);
  keys(metadata, ["version", "provider", "capabilities", "tools"], "provider metadata");
  if (metadata.version !== 1 || metadata.provider !== provider) throw new DevicePolicyError("invalid_config", `Provider ${provider} metadata identity or version does not match`);
  const manifest = readJson("openclaw.plugin.json", 1024 * 1024);
  const contracts = object(manifest.contracts, "plugin contracts");
  if (manifest.id !== provider || !Array.isArray(contracts.tools)) throw new DevicePolicyError("invalid_config", `Provider ${provider} manifest does not match`);
  const rawTools = object(metadata.tools, "provider tools");
  keys(rawTools, ["status", "control", "observe", "guide", "stations"], "provider tools");
  if (!rawTools.status) throw new DevicePolicyError("invalid_config", `Provider ${provider} requires a status tool`);
  const tools: Record<string, string> = {};
  for (const [role, value] of Object.entries(rawTools)) {
    const name = tool(value, `provider tools.${role}`);
    if (!contracts.tools.includes(name)) throw new DevicePolicyError("invalid_config", `Provider ${provider} references an undeclared tool`);
    tools[role] = name;
  }
  if (!Array.isArray(metadata.capabilities) || metadata.capabilities.length < 1 || metadata.capabilities.length > 32) {
    throw new DevicePolicyError("invalid_config", `Provider ${provider} capabilities must contain 1-32 entries`);
  }
  const capabilities = metadata.capabilities.map((value) => id(value, "provider capability"));
  if (new Set(capabilities).size !== capabilities.length) throw new DevicePolicyError("invalid_config", `Provider ${provider} has duplicate capabilities`);
  return { capabilities, tools };
}

export function parseDeviceRegistry(raw: unknown): DeviceRegistry {
  const root = object(raw, "device-management config");
  keys(root, ["providers", "devices"], "device-management config");
  const rawProviders = object(root.providers, "providers");
  if (Object.keys(rawProviders).length < 1 || Object.keys(rawProviders).length > 32) throw new DevicePolicyError("invalid_config", "providers must contain 1-32 entries");
  const providers = new Map<string, DeviceProviderMetadata>();
  for (const [provider, directory] of Object.entries(rawProviders)) {
    id(provider, "provider id");
    providers.set(provider, loadProviderMetadata(provider, string(directory, "provider package directory", 4096)));
  }
  if (!Array.isArray(root.devices) || root.devices.length < 1 || root.devices.length > 128) {
    throw new DevicePolicyError("invalid_config", "devices must contain 1-128 entries");
  }
  const devices = new Map<string, ManagedDevice>();
  for (const [index, item] of root.devices.entries()) {
    const label = `devices[${index}]`;
    const entry = object(item, label);
    keys(entry, ["id", "name", "kind", "siteId", "room", "provider", "grants"], label);
    const deviceId = id(entry.id, `${label}.id`);
    if (devices.has(deviceId)) throw new DevicePolicyError("invalid_config", `duplicate device id ${deviceId}`);
    if (!kinds.has(entry.kind as DeviceKind)) throw new DevicePolicyError("invalid_config", `${label}.kind is invalid`);
    const provider = id(entry.provider, `${label}.provider`);
    const metadata = providers.get(provider);
    if (!metadata) throw new DevicePolicyError("invalid_config", `${label}.provider has no metadata binding`);
    const { tools, capabilities } = metadata;
    const rawGrants = object(entry.grants, `${label}.grants`);
    if (Object.keys(rawGrants).length < 1 || Object.keys(rawGrants).length > 32) {
      throw new DevicePolicyError("invalid_config", `${label}.grants must contain 1-32 agents`);
    }
    const grants = new Map<string, ReadonlySet<DevicePermission>>();
    for (const [agent, value] of Object.entries(rawGrants)) {
      id(agent, `${label}.grants agent`);
      if (!Array.isArray(value) || value.length < 1 || value.length > 4 || value.some((permission) => !permissions.has(permission))) {
        throw new DevicePolicyError("invalid_config", `${label}.grants.${agent} is invalid`);
      }
      const set = new Set(value as DevicePermission[]);
      if (set.size !== value.length) throw new DevicePolicyError("invalid_config", `${label}.grants.${agent} contains duplicates`);
      for (const permission of set) {
        if (permission === "control" && !tools.control || permission === "observe" && !tools.observe || permission === "guide" && !tools.guide) {
          throw new DevicePolicyError("invalid_config", `${label}.grants.${agent} lacks a corresponding tool`);
        }
      }
      grants.set(agent, set);
    }
    devices.set(deviceId, {
      id: deviceId,
      name: string(entry.name, `${label}.name`),
      kind: entry.kind as DeviceKind,
      siteId: id(entry.siteId, `${label}.siteId`),
      room: string(entry.room, `${label}.room`),
      provider,
      capabilities,
      tools,
      grants,
    });
  }
  return devices;
}

/** Reads the canonical manager entry, never a provider's copied ACL. */
export function registryFromOpenClawConfig(config: unknown): DeviceRegistry {
  const root = object(config, "OpenClaw config");
  const plugins = object(root.plugins, "plugins");
  const entries = object(plugins.entries, "plugins.entries");
  const manager = object(entries["device-management"], "plugins.entries.device-management");
  if (manager.enabled === false) throw new DevicePolicyError("unavailable", "Device management is disabled");
  const registry = parseDeviceRegistry(manager.config);
  for (const device of registry.values()) {
    const provider = entries[device.provider];
    if (!provider || typeof provider !== "object" || Array.isArray(provider) || (provider as Record<string, unknown>).enabled === false) {
      throw new DevicePolicyError("unavailable", `Provider ${device.provider} is not enabled`);
    }
    const providerConfig = (provider as Record<string, unknown>).config;
    const providerDevices = providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig)
      ? (providerConfig as Record<string, unknown>).devices : undefined;
    if (!Array.isArray(providerDevices) || !providerDevices.some((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).id === device.id)) {
      throw new DevicePolicyError("invalid_config", `Device ${device.id} is not configured in provider ${device.provider}`);
    }
  }
  return registry;
}

export function authorizedDevices(registry: DeviceRegistry, agentId: string | undefined): ManagedDevice[] {
  return agentId ? [...registry.values()].filter((device) => device.grants.has(agentId)) : [];
}

export function assertDeviceGrant(
  registry: DeviceRegistry,
  agentId: string | undefined,
  deviceId: string,
  provider: string,
  permission: DevicePermission,
): ManagedDevice {
  const device = registry.get(deviceId);
  if (!agentId || !device || device.provider !== provider || !device.grants.get(agentId)?.has(permission)) {
    throw new DevicePolicyError("device_denied", "Device is not available to this agent");
  }
  return device;
}

export function publicDevice(device: ManagedDevice, agentId: string) {
  const grants = device.grants.get(agentId);
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    siteId: device.siteId,
    room: device.room,
    provider: device.provider,
    capabilities: device.capabilities,
    permissions: [...(grants ?? [])],
    tools: Object.fromEntries(Object.entries(device.tools).filter(([role]) =>
      role === "status" || role === "stations" ? grants?.has("read") : grants?.has(role === "control" ? "control" : role === "observe" ? "observe" : "guide"))),
  };
}
