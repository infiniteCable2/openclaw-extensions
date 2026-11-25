import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** The single owner of device identity, location, presentation and agent grants. */
export type DevicePermission = "read" | "control" | "observe" | "guide";
export type DeviceKind = "light" | "switch" | "media_receiver" | "television" | "computer" | "speaker" | "vehicle" | "ev_charger" | "thermostat";
export type DeviceToolRole = "status" | "history" | "control" | "observe" | "guide" | "stations" | "maintenance";
export type DeviceCapabilityAccess = Readonly<Partial<Record<DeviceToolRole, true | readonly string[]>>>;

export const deviceToolPermissions: Readonly<Record<DeviceToolRole, DevicePermission>> = {
  status: "read", history: "read", stations: "read", control: "control", maintenance: "control", observe: "observe", guide: "guide",
};

export type DeviceBindingScope = { profileId: string; sessionKey?: string; channels?: readonly string[] };
type DeviceBindingContext = {
  sessionKey?: string;
  messageChannel?: string;
  isPrivateRequesterProfile?: (profileId: string) => boolean;
};

export function matchesDeviceBinding(context: DeviceBindingContext, binding: DeviceBindingScope): boolean {
  return (!binding.sessionKey || binding.sessionKey === context.sessionKey) &&
    (!binding.channels || (context.messageChannel !== undefined && binding.channels.includes(context.messageChannel))) &&
    context.isPrivateRequesterProfile?.(binding.profileId) === true;
}

export type ManagedDevice = {
  id: string;
  name: string;
  kind: DeviceKind;
  siteId: string;
  room: string;
  provider: string;
  personalReadProfileId?: string;
  providers?: readonly string[];
  sources?: readonly ({ provider: string } & DeviceProviderMetadata)[];
  capabilities: readonly string[];
  capabilityAccess?: ReadonlyMap<string, DeviceCapabilityAccess>;
  tools: Readonly<Partial<Record<DeviceToolRole, string>>>;
  grants: ReadonlyMap<string, ReadonlySet<DevicePermission>>;
};

export type DeviceRegistry = ReadonlyMap<string, ManagedDevice>;
export type DeviceProviderMetadata = Pick<ManagedDevice, "capabilities" | "capabilityAccess" | "tools">;
type ProviderDeclaration = DeviceProviderMetadata & { statusByBrand?: ReadonlyMap<string, string> };

const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const toolPattern = /^[a-z][a-z0-9_]*$/;
const kinds = new Set<DeviceKind>(["light", "switch", "media_receiver", "television", "computer", "speaker", "vehicle", "ev_charger", "thermostat"]);
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
export function loadProviderMetadata(provider: string, packageRoot: string): ProviderDeclaration {
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
  keys(metadata, ["version", "provider", "capabilities", "capabilityAccess", "tools", "statusByBrand"], "provider metadata");
  if (metadata.version !== 1 || metadata.provider !== provider) throw new DevicePolicyError("invalid_config", `Provider ${provider} metadata identity or version does not match`);
  const manifest = readJson("openclaw.plugin.json", 1024 * 1024);
  const contracts = object(manifest.contracts, "plugin contracts");
  if (manifest.id !== provider || !Array.isArray(contracts.tools)) throw new DevicePolicyError("invalid_config", `Provider ${provider} manifest does not match`);
  const rawTools = object(metadata.tools, "provider tools");
  keys(rawTools, Object.keys(deviceToolPermissions), "provider tools");
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
  const access = metadata.capabilityAccess === undefined
    ? undefined
    : object(metadata.capabilityAccess, "provider capability access");
  const capabilityAccess = access && new Map(capabilities.map((capability) => {
    const rules = object(access[capability], `access for ${capability}`);
    if (!Object.keys(rules).length) throw new DevicePolicyError("invalid_config", "Capability access is empty");
    const entries = Object.entries(rules).map(([role, commands]) => {
      if (!Object.hasOwn(tools, role) || (commands !== true &&
          (!Array.isArray(commands) || commands.length < 1 || commands.length > 128 ||
           new Set(commands).size !== commands.length ||
           commands.some((command) => typeof command !== "string" || !/^[a-z][a-z0-9_.-]{1,127}$/.test(command))))) {
        throw new DevicePolicyError("invalid_config", "Invalid capability access rule");
      }
      return [role, commands];
    });
    return [capability, Object.fromEntries(entries) as DeviceCapabilityAccess] as const;
  }));
  if (access && Object.keys(access).length !== capabilities.length) {
    throw new DevicePolicyError("invalid_config", "Unexpected capability access rule");
  }
  const declaration = { capabilities, ...(capabilityAccess && { capabilityAccess }), tools };
  if (metadata.statusByBrand === undefined) return declaration;
  const brandEntries = Object.entries(object(metadata.statusByBrand, "provider brand status tools"));
  if (brandEntries.length < 1 || brandEntries.length > 32) throw new DevicePolicyError("invalid_config", `Provider ${provider} has invalid brand status tools`);
  const statusByBrand = new Map<string, string>();
  for (const [brand, value] of brandEntries) {
    if (!idPattern.test(brand)) throw new DevicePolicyError("invalid_config", `Provider ${provider} has an invalid brand`);
    const name = tool(value, "provider brand status tool");
    if (!contracts.tools.includes(name) || Object.entries(tools).some(([role, toolName]) => role !== "status" && toolName === name)) {
      throw new DevicePolicyError("invalid_config", `Provider ${provider} has an invalid brand status tool`);
    }
    statusByBrand.set(brand, name);
  }
  return { ...declaration, statusByBrand };
}

export function parseDeviceRegistry(raw: unknown): DeviceRegistry {
  return parseRegistry(raw);
}

function parseRegistry(raw: unknown, binding?: (provider: string, device: string) => Record<string, unknown>): DeviceRegistry {
  const root = object(raw, "device-management config");
  keys(root, ["providers", "devices", "diagnosticViewers"], "device-management config");
  const rawProviders = object(root.providers, "providers");
  if (Object.keys(rawProviders).length < 1 || Object.keys(rawProviders).length > 32) throw new DevicePolicyError("invalid_config", "providers must contain 1-32 entries");
  const providers = new Map<string, ProviderDeclaration>();
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
    keys(entry, ["id", "name", "kind", "siteId", "room", "provider", "additionalProviders", "grants", "personalReadProfileId"], label);
    const deviceId = id(entry.id, `${label}.id`);
    if (devices.has(deviceId)) throw new DevicePolicyError("invalid_config", `duplicate device id ${deviceId}`);
    if (!kinds.has(entry.kind as DeviceKind)) throw new DevicePolicyError("invalid_config", `${label}.kind is invalid`);
    const personalReadProfileId = entry.personalReadProfileId;
    if (personalReadProfileId !== undefined &&
        (entry.kind !== "vehicle" || typeof personalReadProfileId !== "string" || !idPattern.test(personalReadProfileId))) {
      throw new DevicePolicyError("invalid_config", `${label}.personalReadProfileId requires a vehicle and a valid profile ID`);
    }
    const provider = id(entry.provider, `${label}.provider`);
    if (!providers.has(provider)) throw new DevicePolicyError("invalid_config", `${label}.provider has no metadata binding`);
    const extra = entry.additionalProviders ?? [];
    if (!Array.isArray(extra) || extra.length > 7) throw new DevicePolicyError("invalid_config", `${label}.additionalProviders is invalid`);
    const bindings = [provider, ...extra.map((item) => id(item, `${label}.additionalProviders`))];
    if (new Set(bindings).size !== bindings.length || bindings.some((item) => !providers.has(item))) {
      throw new DevicePolicyError("invalid_config", `${label}.additionalProviders is duplicated or unbound`);
    }
    const sources = bindings.map((providerId) => {
      const { statusByBrand, ...metadata } = providers.get(providerId)!;
      const brand = binding?.(providerId, deviceId).brand;
      const status = entry.kind === "vehicle" && typeof brand === "string" ? statusByBrand?.get(brand) : undefined;
      return { ...metadata, provider: providerId, tools: status ? { ...metadata.tools, status } : metadata.tools };
    });
    const { tools, capabilities, capabilityAccess } = sources[0]!;
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
        if (permission === "control" && !sources.some((source) => source.tools.control) || permission === "observe" && !sources.some((source) => source.tools.observe) || permission === "guide" && !sources.some((source) => source.tools.guide)) {
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
      ...(personalReadProfileId !== undefined ? { personalReadProfileId } : {}),
      ...(bindings.length > 1 ? { providers: bindings, sources } : {}),
      capabilities: bindings.length > 1 ? [...new Set(sources.flatMap((source) => source.capabilities))] : capabilities,
      capabilityAccess,
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
  return parseRegistry(manager.config, (providerId, deviceId) => {
    const provider = entries[providerId];
    if (!provider || typeof provider !== "object" || Array.isArray(provider) || (provider as Record<string, unknown>).enabled === false) {
      throw new DevicePolicyError("unavailable", `Provider ${providerId} is not enabled`);
    }
    const providerConfig = (provider as Record<string, unknown>).config;
    const providerDevices = providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig)
      ? (providerConfig as Record<string, unknown>).devices : undefined;
    const device = Array.isArray(providerDevices) ? providerDevices.find((entry): entry is Record<string, unknown> =>
      entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).id === deviceId) : undefined;
    if (!device) throw new DevicePolicyError("invalid_config", `Device ${deviceId} is not configured in provider ${providerId}`);
    return device;
  });
}

export function authorizedDevices(registry: DeviceRegistry, agentId: string | undefined): ManagedDevice[] {
  return agentId ? [...registry.values()].filter((device) => device.grants.has(agentId)) : [];
}

export function hasDeviceProvider(device: ManagedDevice, provider: string): boolean {
  return device.provider === provider || device.providers?.includes(provider) === true;
}

export function assertDeviceGrant(
  registry: DeviceRegistry,
  agentId: string | undefined,
  deviceId: string,
  provider: string,
  permission: DevicePermission,
): ManagedDevice {
  const device = registry.get(deviceId);
  if (!agentId || !device || !hasDeviceProvider(device, provider) || !device.grants.get(agentId)?.has(permission)) {
    throw new DevicePolicyError("device_denied", "Device is not available to this agent");
  }
  return device;
}

export type VehicleReadToolContext = {
  readonly agentId?: string;
  readonly senderIsOwner?: boolean;
  readonly isPrivateRequesterProfile?: (profileId: string) => boolean;
  readonly assertInvocationCurrent?: () => void;
};

export function vehicleReadAuthority(
  device: ManagedDevice,
  context: VehicleReadToolContext,
  allowPersonal = true,
): { kind: "owner"; profileId?: never } | { kind: "personal"; profileId: string } | undefined {
  if (!context.agentId || !device.grants.get(context.agentId)?.has("read")) return;
  if (context.senderIsOwner === true) return { kind: "owner" };
  const profileId = device.personalReadProfileId;
  if (!allowPersonal || device.kind !== "vehicle" || !profileId) return;
  try {
    if (context.isPrivateRequesterProfile?.(profileId) === true) return { kind: "personal", profileId };
  } catch {
    // A revoked or unavailable host proof must not make a vehicle visible.
  }
}

export function publicDevice(device: ManagedDevice, agentId: string, readOnly = false) {
  const deviceGrants = device.grants.get(agentId);
  const grants = readOnly ? new Set(deviceGrants?.has("read") ? ["read" as const] : []) : deviceGrants;
  const availableTools = (tools: ManagedDevice["tools"]) => Object.fromEntries(Object.entries(tools).filter(([role, name]) => {
    if (readOnly) return grants?.has("read") && role === "status" && (name === "smartcar_vehicle" || name === "cupra_vehicle");
    return grants?.has(deviceToolPermissions[role as DeviceToolRole]);
  }));
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    siteId: device.siteId,
    room: device.room,
    provider: device.provider,
    ...(device.sources ? { sources: device.sources.map((source) => ({
      provider: source.provider,
      capabilities: source.capabilities,
      tools: availableTools(source.tools),
    })) } : {}),
    capabilities: device.capabilities,
    permissions: [...(grants ?? [])],
    tools: availableTools(device.tools),
  };
}
