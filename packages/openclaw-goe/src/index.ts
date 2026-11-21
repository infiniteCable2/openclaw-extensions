import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertDeviceGrant,
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
const command = "network.device.read";
const name = "goe_status";
const idPattern = "^[a-z0-9][a-z0-9_-]{0,63}$";
const id = new RegExp(idPattern);
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

function bindingFor(config: unknown, deviceId: string) {
  const bindings = record(config)?.devices;
  if (!Array.isArray(bindings)) return undefined;
  const entries = bindings.map(record);
  const matches = entries.filter((item) => item?.id === deviceId);
  const binding = matches[0];
  if (
    matches.length !== 1 ||
    typeof binding?.nodeId !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.nodeId) ||
    entries.some((item) => item !== binding && item?.nodeId === binding.nodeId) ||
    typeof binding.profileId !== "string" ||
    !id.test(binding.profileId) ||
    !Array.isArray(binding.commands) ||
    binding.commands.length !== 1 ||
    binding.commands[0] !== command
  ) {
    return undefined;
  }
  return { nodeId: binding.nodeId, profileId: binding.profileId };
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

const failure = (code: string, message: string) =>
  jsonResult({ ok: false, error: { code, message } });

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

          const config = api.runtime.config.current();
          const entry = config.plugins?.entries?.[provider];
          if (!entry || entry.enabled === false) return;
          try {
            const available = authorizedDevices(registryFromOpenClawConfig(config), agentId).some(
              (device) => {
                if (
                  device.kind !== "ev_charger" ||
                  device.provider !== provider ||
                  !device.grants.get(agentId)?.has("read")
                )
                  return false;
                const binding = bindingFor(entry.config, device.id);
                return binding !== undefined && matchesDeviceBinding(context, binding);
              },
            );
            if (!available) return;
          } catch {
            return;
          }

          return {
            name,
            label: "go-e charging status",
            description:
              "Read the current charging state, charging permission and configured current of an assigned go-e charger. Use the device ID from device_inventory.",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["device"],
              properties: { device: { type: "string", pattern: idPattern } },
            } as never,
            async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
              const input = record(args);
              const device = input?.device;
              if (
                !input ||
                Object.keys(input).length !== 1 ||
                typeof device !== "string" ||
                !id.test(device) ||
                !toolCallId
              ) {
                return failure(
                  "invalid_request",
                  "Use an assigned charger ID from device_inventory.",
                );
              }

              const authorize = () => {
                signal?.throwIfAborted();
                context.assertInvocationCurrent();
                const current = api.runtime.config.current();
                const entry = current.plugins?.entries?.[provider];
                const managed = assertDeviceGrant(
                  registryFromOpenClawConfig(current),
                  agentId,
                  device,
                  provider,
                  "read",
                );
                const binding = bindingFor(entry?.config, device);
                if (
                  !entry ||
                  entry.enabled === false ||
                  managed.kind !== "ev_charger" ||
                  !binding ||
                  !matchesDeviceBinding(context, binding) ||
                  !hasGatewayToolRoutingContext()
                ) {
                  throw new Error("The charger is not available in this private assistant turn");
                }
                return binding;
              };
              let selected: NonNullable<ReturnType<typeof bindingFor>>;
              try {
                selected = authorize();
              } catch {
                signal?.throwIfAborted();
                return failure(
                  "device_denied",
                  "The charger requires an assigned, private assistant session.",
                );
              }

              const assertCurrent = () => {
                const current = authorize();
                if (
                  current.nodeId !== selected.nodeId ||
                  current.profileId !== selected.profileId
                ) {
                  throw new Error("The charger assignment changed during the request");
                }
              };

              try {
                const { nodes } = await api.runtime.nodes.list({ connected: true });
                assertCurrent();
                const node = nodes.find(
                  (candidate) => candidate.nodeId === selected.nodeId && candidate.connected,
                );
                if (!node)
                  return failure(
                    "device_offline",
                    "The paired device for this charger is offline.",
                  );
                if (!node.invocableCommands?.includes(command)) {
                  return failure(
                    "device_read_unavailable",
                    "Charger status is unavailable on the paired device. Check its local Wallbox and Wi-Fi approval.",
                  );
                }

                const result = await callGatewayTool<unknown>(
                  "node.invoke",
                  { timeoutMs: timeoutMs + 2_000 },
                  {
                    nodeId: selected.nodeId,
                    command,
                    params: {},
                    timeoutMs,
                    sessionKey,
                    idempotencyKey: createHash("sha256")
                      .update(JSON.stringify([runId, toolCallId, device, selected.nodeId]))
                      .digest("hex"),
                  },
                  {
                    requireAgentRuntimeIdentity: true,
                    dispatchAuthority: { version: 2, kind: "source-bound", assertCurrent },
                    ...(signal ? { signal } : {}),
                  },
                );
                assertCurrent();
                const status = statusFromReply(result);
                return status
                  ? jsonResult({ ok: true, device, ...status })
                  : failure(
                      "device_reply_invalid",
                      "The paired device did not return a valid charging status.",
                    );
              } catch {
                signal?.throwIfAborted();
                try {
                  assertCurrent();
                } catch {
                  return failure(
                    "device_denied",
                    "The device or assistant permission changed during the request.",
                  );
                }
                return failure(
                  "device_read_unavailable",
                  "Charger status could not be read. Check the paired device and its local Wallbox and Wi-Fi approval.",
                );
              }
            },
          };
        },
      },
      { name, optional: true, workspaceAccess: false },
    );
  },
});
