import {
  deviceToolPermissions,
  matchesDeviceBinding,
  type DeviceBindingScope,
  type DeviceToolRole,
  type ManagedDevice,
} from "./policy.js";

export type InventoryContext = Parameters<typeof matchesDeviceBinding>[0] & {
  agentId?: string;
  backgroundRun?: unknown;
};
export type IsToolCallable = (provider: string, tool: string) => boolean;
export type InventoryNode = {
  nodeId: string;
  connected?: boolean;
  invocableCommands?: readonly string[];
};

type NodeBinding = DeviceBindingScope & {
  nodeId: string;
  commands: readonly string[];
};

type CapabilityDetails = {
  id: string;
  available: boolean;
  reason?: string;
  commands?: string[];
  supportedCommands?: string[];
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function canInspectDevicePermissions(config: unknown, context: InventoryContext): boolean {
  const viewers = record(config).diagnosticViewers;
  return (
    !!context.agentId &&
    !!context.sessionKey &&
    !context.backgroundRun &&
    Array.isArray(viewers) &&
    viewers.some((row: unknown) => {
      const viewer = record(row);
      return (
        viewer.agentId === context.agentId &&
        typeof viewer.profileId === "string" &&
        matchesDeviceBinding(context, { profileId: viewer.profileId })
      );
    })
  );
}

function configuredNodeBinding(value: unknown): NodeBinding | undefined {
  const item = record(value);
  const { nodeId, profileId, commands, sessionKey, channels } = item;
  if (
    typeof nodeId !== "string" ||
    typeof profileId !== "string" ||
    !strings(commands) ||
    (sessionKey !== undefined && (typeof sessionKey !== "string" || !sessionKey)) ||
    (channels !== undefined && !strings(channels))
  ) {
    return undefined;
  }
  return { nodeId, profileId, commands, sessionKey, channels };
}

export function deviceUsesNodeRules(device: Pick<ManagedDevice, "capabilityAccess">): boolean {
  return (
    !!device.capabilityAccess &&
    [...device.capabilityAccess.values()].some((rules) =>
      Object.values(rules).some((rule) => Array.isArray(rule)),
    )
  );
}

export function projectInventoryDevice(params: {
  device: ManagedDevice;
  providerConfig: unknown;
  context: InventoryContext;
  isToolCallable: IsToolCallable;
  nodes: ReadonlyMap<string, InventoryNode>;
  diagnostic: boolean;
}) {
  const { device, providerConfig, context, isToolCallable, nodes, diagnostic } = params;
  const grants = device.grants.get(context.agentId ?? "");
  const allRoles = Object.entries(device.tools) as Array<[DeviceToolRole, string]>;
  const roles = allRoles.filter(
    ([role, name]) =>
      grants?.has(deviceToolPermissions[role]) && isToolCallable(device.provider, name),
  );
  const callableRoles = new Set(roles.map(([role]) => role));
  const configured = record(providerConfig).devices;
  const row =
    Array.isArray(configured) && configured.find((entry) => record(entry).id === device.id);
  const usesNode = deviceUsesNodeRules(device);
  const binding = usesNode ? configuredNodeBinding(row) : undefined;
  const scopeMatches = !!binding && matchesDeviceBinding(context, binding);
  const node = scopeMatches && binding ? nodes.get(binding.nodeId) : undefined;
  const boundCommands = new Set(binding?.commands ?? []);
  const nativeCommands = new Set(node?.connected ? node.invocableCommands : []);
  const visibleRoles = new Set<DeviceToolRole>();

  const details: CapabilityDetails[] = device.capabilities.map((id) => {
    const rules = device.capabilityAccess?.get(id);
    if (!rules) {
      // Legacy metadata describes a provider as a whole, so only disclose it
      // when every declared role reaches the conversation.
      const available = roles.length > 0 && roles.length === allRoles.length;
      if (available) for (const [role] of roles) visibleRoles.add(role);
      return {
        id,
        available,
        ...(!available && { reason: grants ? "tool_not_callable" : "device_not_assigned" }),
      };
    }
    let available = false;
    const commands: string[] = [];
    let roleAllowed = false;
    for (const [role, rule] of Object.entries(rules) as Array<
      [DeviceToolRole, true | readonly string[]]
    >) {
      if (!callableRoles.has(role)) continue;
      roleAllowed = true;
      if (rule === true) {
        available = true;
        visibleRoles.add(role);
        continue;
      }
      const allowed = rule.filter(
        (command) => boundCommands.has(command) && nativeCommands.has(command),
      );
      if (allowed.length) {
        available = true;
        visibleRoles.add(role);
        commands.push(...allowed);
      }
    }
    return {
      id,
      available,
      ...(commands.length > 0 && { commands }),
      ...(diagnostic &&
        usesNode && {
          supportedCommands: [
            ...new Set(Object.values(rules).flatMap((rule) => (rule === true ? [] : rule))),
          ],
        }),
      ...(!available && {
        reason: !grants
          ? "device_not_assigned"
          : !roleAllowed
            ? "tool_or_role_not_callable"
            : !scopeMatches
              ? "private_session_required"
              : !node?.connected
                ? "device_offline_or_unavailable"
                : "node_command_not_available",
      }),
    };
  });

  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    siteId: device.siteId,
    room: device.room,
    provider: device.provider,
    capabilities: details.filter(({ available }) => available).map(({ id }) => id),
    tools: Object.fromEntries(roles.filter(([role]) => visibleRoles.has(role))),
    permissions: [
      ...new Set(
        roles
          .filter(([role]) => visibleRoles.has(role))
          .map(([role]) => deviceToolPermissions[role]),
      ),
    ],
    ...(node && { connected: node.connected === true }),
    ...(details.some(({ commands }) => commands?.length) && {
      commands: [...new Set(details.flatMap(({ commands }) => commands ?? []))],
    }),
    ...(diagnostic && { assigned: !!grants, capabilityDiagnostics: details }),
  };
}
