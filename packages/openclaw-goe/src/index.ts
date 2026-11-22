import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  authorizedDevices,
  matchesDeviceBinding,
  registryFromOpenClawConfig,
} from "@infinitecable2/openclaw-device-management/policy";
import {
  callGatewayTool,
  hasGatewayToolRoutingContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";

const provider = "goe";
const legacyCommand = "network.device.read";
const addressedCommand = "network.device.read.v2";
const name = "goe_status";
const idPattern = "^[a-z0-9][a-z0-9_-]{0,63}$";
const id = new RegExp(idPattern);
const deviceKeyPattern = /^[0-9]{6}$/;
const timeoutMs = 10_000;
const states = new Set(["idle", "charging", "waitingForCar", "complete", "error", "unknown"]);
const { configSchema } = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type ChargerRoute =
  | { command: typeof legacyCommand; deviceKey?: never }
  | { command: typeof addressedCommand; deviceKey: string };
type ChargerBinding = { nodeId: string; profileId: string } & ChargerRoute;

function chargerRoute(entry: Record<string, unknown>): ChargerRoute | undefined {
  const { commands, deviceKey } = entry;
  if (!Array.isArray(commands) || commands.length !== 1) return;
  if (commands[0] === legacyCommand && deviceKey === undefined) {
    return { command: legacyCommand };
  }
  if (commands[0] === addressedCommand && typeof deviceKey === "string" && deviceKeyPattern.test(deviceKey)) {
    return { command: addressedCommand, deviceKey };
  }
}

function bindingFor(
  entries: readonly Record<string, unknown>[],
  deviceId: string,
): ChargerBinding | undefined {
  const matches = entries.filter((item) => item?.id === deviceId);
  const binding = matches[0];
  if (
    matches.length !== 1 ||
    typeof binding?.nodeId !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.nodeId) ||
    typeof binding.profileId !== "string" ||
    !id.test(binding.profileId)
  ) {
    return undefined;
  }
  const route = chargerRoute(binding);
  if (!route) return;
  const peers = entries.filter((item) => item.nodeId === binding.nodeId);
  if (peers.length > 1) {
    const routes = peers.map(chargerRoute);
    const keys = new Set(routes.map((item) => item?.deviceKey));
    if (keys.has(undefined) || keys.size !== peers.length) return;
  }
  return { nodeId: binding.nodeId, profileId: binding.profileId, ...route };
}

function statusFromReply(reply: unknown) {
  const status = record(record(reply)?.payload);
  if (!status || typeof status.chargingState !== "string" || !states.has(status.chargingState)) {
    return undefined;
  }
  const { chargingState, chargingAllowed, allowedCurrentAmps } = status;
  return {
    chargingState,
    ...(typeof chargingAllowed === "boolean" ? { chargingAllowed } : {}),
    ...(typeof allowedCurrentAmps === "number" &&
    Number.isInteger(allowedCurrentAmps) &&
    allowedCurrentAmps >= 0 &&
    allowedCurrentAmps <= 32
      ? { allowedCurrentAmps }
      : {}),
  };
}

const failureMessages = {
  invalid_request: "Read the assigned charger using an optional device ID from device_inventory.",
  device_selection_required: "Select a charger from device_inventory.",
  device_not_assigned: "That charger is unavailable for this assistant. Check device_inventory.",
  device_assignment_invalid: "The charger assignment is incomplete or ambiguous. Each charger on a shared node needs its own approved device key.",
  device_private_turn_required: "Read the charger during an active private assistant voice turn.",
  device_offline: "The paired device for this charger is offline.",
  device_command_unavailable: "The paired device currently offers no charger status command. Check the network feature, saved Wi-Fi and location permission in Element.",
  device_dispatch_failed: "The gateway could not hand off or complete the charger read.",
  device_dispatch_unconfirmed: "The gateway handed off the read and could not confirm an Android result.",
  device_read_timeout: "The charger read expired before a status was returned.",
  device_android_permission_required: "Android rejected the read. Check the local charger approval for the current Wi-Fi and keep the assistant visible.",
  device_android_wifi_unavailable: "Element needs an active Wi-Fi connection outside a VPN to read the charger.",
  device_android_wifi_not_approved: "Approve the current Wi-Fi once in Element's Wallbox settings.",
  device_android_wifi_changed: "Element stopped the read after the Wi-Fi changed. Retry on an approved Wi-Fi network.",
  device_android_not_approved: "Approve this charger in Element's Wallbox settings before reading it.",
  device_android_target_required: "Element needs a specific charger assignment for this read.",
  device_android_invalid_request: "Element rejected the charger request format.",
  device_android_discovery_failed: "Element could not discover the assigned charger on the current Wi-Fi.",
  device_android_discovery_timeout: "Element ran out of time looking for the assigned charger.",
  device_android_discovery_network_mismatch:
    "Element could not confirm the discovered charger service belongs to the approved Wi-Fi network.",
  device_android_discovery_serial_missing:
    "Element found a charger service without a usable serial number.",
  device_android_discovery_serial_mismatch:
    "Element found a charger service with a different serial number.",
  device_android_discovery_unresolved:
    "Element could not resolve the network address of the discovered charger service.",
  device_android_http_timeout: "Element timed out waiting for the charger to respond.",
  device_android_http_unreachable: "Element could not reach the charger's local status service.",
  device_android_http_rejected: "The charger rejected the local status request from Element.",
  device_android_invalid_response: "Element received an unreadable charger status.",
  device_android_identity_mismatch: "The charger identity could not be verified for this assignment.",
  device_android_read_failed: "The Android device reported that it could not read the charger.",
  device_reply_invalid: "The paired device did not return a valid charging status.",
} as const;

type FailureCode = keyof typeof failureMessages;
const failure = (code: FailureCode) =>
  jsonResult({ ok: false, error: { code, message: failureMessages[code] } });

const androidFailures = new Map<string, FailureCode>([
  ["GO_E_WLAN_APPROVAL_REQUIRED", "device_android_permission_required"],
  ["GO_E_WIFI_UNAVAILABLE", "device_android_wifi_unavailable"],
  ["GO_E_WIFI_NOT_APPROVED", "device_android_wifi_not_approved"],
  ["GO_E_WIFI_CHANGED", "device_android_wifi_changed"],
  ["GO_E_DEVICE_NOT_APPROVED", "device_android_not_approved"],
  ["GO_E_TARGET_REQUIRED", "device_android_target_required"],
  ["PERMISSION_REQUIRED", "device_android_permission_required"],
  ["GO_E_DISCOVERY_FAILED", "device_android_discovery_failed"],
  ["GO_E_DISCOVERY_TIMEOUT", "device_android_discovery_timeout"],
  ["GO_E_DISCOVERY_NETWORK_MISMATCH", "device_android_discovery_network_mismatch"],
  ["GO_E_DISCOVERY_SERIAL_MISSING", "device_android_discovery_serial_missing"],
  ["GO_E_DISCOVERY_SERIAL_MISMATCH", "device_android_discovery_serial_mismatch"],
  ["GO_E_DISCOVERY_UNRESOLVED", "device_android_discovery_unresolved"],
  ["GO_E_SERVICE_MISMATCH", "device_android_identity_mismatch"],
  ["GO_E_HTTP_TIMEOUT", "device_android_http_timeout"],
  ["GO_E_HTTP_UNREACHABLE", "device_android_http_unreachable"],
  ["GO_E_HTTP_REJECTED", "device_android_http_rejected"],
  ["GO_E_INVALID_RESPONSE", "device_android_invalid_response"],
  ["GO_E_IDENTITY_MISMATCH", "device_android_identity_mismatch"],
  ["NOT_AUTHORIZED", "device_android_permission_required"],
  ["NOT_AVAILABLE", "device_android_read_failed"],
  ["EXECUTION_FAILED", "device_android_read_failed"],
  ["INVALID_PARAMS", "device_android_invalid_request"],
  ["UNKNOWN_COMMAND", "device_android_read_failed"],
]);

function gatewayFailure(error: unknown): FailureCode {
  const outer = record(error);
  const details = record(outer?.details);
  const nodeCode = record(details?.nodeError)?.code;
  const detailCode = details?.code;
  const message = outer?.message;
  // This Core reports its Matrix run rejection with a fixed message.
  if (
    (outer?.gatewayCode === "FORBIDDEN" &&
      (message === "Matrix node invoke requires a current admitted agent run for this room and node" ||
        message === "Matrix node invoke authority closed")) ||
    message === "trusted agent runtime identity required for this gateway call" ||
    message === "trusted operational run instance required for this gateway call"
  ) {
    return "device_private_turn_required";
  }
  if (outer?.code === "CLIENT_TIMEOUT" || nodeCode === "TIMEOUT" || detailCode === "TIMEOUT") {
    return "device_read_timeout";
  }
  if (nodeCode === "NOT_CONNECTED" || detailCode === "NOT_CONNECTED") {
    return "device_offline";
  }
  if (outer?.gatewayCode === "UNAVAILABLE" && details?.nodeCommandDispatched === true) {
    // Handing a request to transport does not prove receipt by the phone.
    const androidFailure = typeof nodeCode === "string" ? androidFailures.get(nodeCode) : undefined;
    return androidFailure ?? "device_dispatch_unconfirmed";
  }
  return "device_dispatch_failed";
}

export default definePluginEntry({
  id: provider,
  name: "go-e Chargers",
  description: "Read assigned go-e charger status through an authorized Matrix Node.",
  configSchema: buildJsonPluginConfigSchema(configSchema),
  register(api) {
    api.registerTool(
      {
        contextVersion: 2,
        create(context: OpenClawPluginToolContext<2>) {
          const { agentId, sessionKey, runId, isPrivateRequesterProfile } = context;
          if (!agentId || !sessionKey || !runId || !isPrivateRequesterProfile) return;

          const readBindings = (): Map<string, ChargerBinding | undefined> => {
            try {
              const config = api.runtime.config.current();
              const entry = config.plugins?.entries?.[provider];
              if (!entry || entry.enabled === false) return new Map();
              const configured = record(entry.config)?.devices;
              if (!Array.isArray(configured)) return new Map();
              const entries = configured.map(record).filter((row) => row !== undefined);
              const assigned = new Map<string, ChargerBinding | undefined>();
              for (const device of authorizedDevices(registryFromOpenClawConfig(config), agentId)) {
                if (
                  device.kind !== "ev_charger" ||
                  device.provider !== provider ||
                  !device.grants.get(agentId)?.has("read")
                ) {
                  continue;
                }
                const row = entries.find((item) => item.id === device.id);
                const profileId = row?.profileId;
                const commands = row?.commands;
                if (
                  Array.isArray(commands) && commands.length === 1 &&
                  (commands[0] === legacyCommand || commands[0] === addressedCommand) &&
                  typeof profileId === "string" && id.test(profileId) &&
                  matchesDeviceBinding(context, { profileId })
                ) {
                  assigned.set(device.id, bindingFor(entries, device.id));
                }
              }
              return assigned;
            } catch {
              return new Map();
            }
          };
          if (!readBindings().size) return;

          return {
            name,
            label: "go-e charging status",
            description:
              "Read the charging state, permission and configured current. Omit the device ID for a single assigned go-e charger. Select a device from device_inventory when several are assigned.",
            parameters: {
              type: "object",
              additionalProperties: false,
              properties: { device: { type: "string", pattern: idPattern } },
            } as never,
            async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
              const input = record(args);
              const requested = input?.device;
              if (
                !input ||
                Object.keys(input).some((key) => key !== "device") ||
                (requested !== undefined && (typeof requested !== "string" || !id.test(requested))) ||
                !toolCallId
              ) {
                return failure("invalid_request");
              }

              const hasCurrentTurn = () => {
                signal?.throwIfAborted();
                try {
                  context.assertInvocationCurrent();
                  return hasGatewayToolRoutingContext();
                } catch {
                  return false;
                }
              };
              if (!hasCurrentTurn()) return failure("device_private_turn_required");
              const assignments = readBindings();
              if (requested === undefined && assignments.size > 1) {
                return failure("device_selection_required");
              }
              const device = requested ?? assignments.keys().next().value;
              if (!device || !assignments.has(device)) return failure("device_not_assigned");
              const selected = assignments.get(device);
              if (!selected) return failure("device_assignment_invalid");

              const assignmentIsCurrent = () => {
                const current = readBindings().get(device);
                return current?.nodeId === selected.nodeId &&
                  current.profileId === selected.profileId &&
                  current.command === selected.command &&
                  current.deviceKey === selected.deviceKey;
              };
              const assertCurrent = () => {
                if (!hasCurrentTurn() || !assignmentIsCurrent()) {
                  throw new Error("The charger assignment changed during the request");
                }
              };

              try {
                const { nodes } = await api.runtime.nodes.list({ connected: true });
                assertCurrent();
                const node = nodes.find(
                  (candidate) => candidate.nodeId === selected.nodeId && candidate.connected,
                );
                if (!node) return failure("device_offline");
                if (!node.invocableCommands?.includes(selected.command)) {
                  return failure("device_command_unavailable");
                }

                const result = await callGatewayTool<unknown>(
                  "node.invoke",
                  { timeoutMs: timeoutMs + 2_000 },
                  {
                    nodeId: selected.nodeId,
                    command: selected.command,
                    params: selected.command === addressedCommand
                      ? { plugin: "go-e", deviceKey: selected.deviceKey }
                      : {},
                    timeoutMs,
                    sessionKey,
                    idempotencyKey: createHash("sha256")
                      .update(JSON.stringify([runId, toolCallId, device, selected.nodeId, selected.command, selected.deviceKey]))
                      .digest("hex"),
                  },
                  {
                    requireAgentRuntimeIdentity: true,
                    dispatchAuthority: { version: 2, kind: "source-bound", assertCurrent },
                    ...(signal ? { signal } : {}),
                  },
                );
                assertCurrent();
                if (
                  selected.command === addressedCommand &&
                  record(record(result)?.payload)?.deviceKey !== selected.deviceKey
                ) {
                  return failure("device_android_identity_mismatch");
                }
                const status = statusFromReply(result);
                return status
                  ? jsonResult({ ok: true, device, ...status })
                  : failure("device_reply_invalid");
              } catch (error) {
                if (!hasCurrentTurn()) return failure("device_private_turn_required");
                if (!assignmentIsCurrent()) return failure("device_not_assigned");
                return failure(gatewayFailure(error));
              }
            },
          };
        },
      },
      { name, optional: true, workspaceAccess: false },
    );
  },
});
