import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  assertDeviceGrant,
  authorizedDevices,
  matchesDeviceBinding,
  registryFromOpenClawConfig,
} from "@infinitecable2/openclaw-device-management/policy";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { decodeEchoCapture, saveEchoCapture } from "./capture.js";
import {
  captureCommands,
  echoCommands,
  echoToolParameters,
  operations,
  parseEchoAction,
  readEchoBindings,
  type EchoAction,
  type EchoBinding,
  type EchoCommand,
  type EchoPermission,
} from "./contract.js";

const provider = "echo";
const timeoutMs = 5_000;
const maxResultBytes = 64 * 1024;
// These fields are host-projected by current V2. Older generated SDK declarations
// omit them, and older runtimes without them fail closed.
export type EchoToolContext = OpenClawPluginToolContext<2> & {
  runId?: string;
  isPrivateRequesterProfile?: (profileId: string) => boolean;
};

const tools = {
  read: {
    name: "echo_status",
    label: "Echo status",
    description:
      "Read an assigned Echo's status, inventory, privacy, local alarms and timers, audio, Bluetooth, radio, weather or Show notifications. Use a device ID from device_inventory.",
  },
  control: {
    name: "echo_control",
    label: "Echo control",
    description:
      "Control local alarms, timers, audio transport, Bluetooth, radio and built-in Show views or plain-text notifications. Use a device ID from device_inventory. Read status before selecting an alarm, timer, radio station or Bluetooth output. Pairing a phone and choosing an audio output are separate. Alarm times use the Echo's time zone.",
  },
  observe: {
    name: "echo_capture",
    label: "Echo capture",
    description:
      "Capture one photo or a short microphone recording from an assigned Echo only on explicit request. Camera and microphone need separate device-side enablement. Returns a private file for this request; share it only when asked.",
  },
} as const;

type EchoInvocation = {
  nodeId: string;
  command: EchoCommand;
  args: unknown;
  key: string;
  timeoutMs: number;
  isCurrent: () => boolean;
  used: boolean;
};

function deny(code: string, message: string) {
  return { ok: false as const, code, message };
}

function readState(api: OpenClawPluginApi) {
  const config = api.runtime.config.current();
  const entry = config.plugins?.entries?.[provider];
  if (!entry || entry.enabled === false) {
    throw new Error("Echo device tools are disabled");
  }
  return { bindings: readEchoBindings(entry.config), registry: registryFromOpenClawConfig(config) };
}

function echoPayload(raw: unknown) {
  if (!raw || typeof raw !== "object" || !("payload" in raw)) {
    throw new Error("Missing Echo result payload");
  }
  return raw.payload;
}

export function registerEchoTools(api: OpenClawPluginApi) {
  // The public RPC carries no agent-supplied proof. Only this tool's host-owned
  // invocation can authorize the plugin policy, even if `nodes` is also exposed.
  const active = new AsyncLocalStorage<EchoInvocation>();
  const handle: OpenClawPluginNodeInvokePolicy["handle"] = async (ctx) => {
    const invocation = active.getStore();
    if (
      !invocation ||
      invocation.used ||
      invocation.nodeId !== ctx.nodeId ||
      invocation.command !== ctx.command ||
      invocation.key !== ctx.idempotencyKey ||
      ctx.node?.deviceFamily !== "echo" ||
      !invocation.isCurrent()
    ) {
      return deny(
        "NOT_AUTHORIZED",
        "This Echo command requires an authorized private request through its device tool.",
      );
    }
    invocation.used = true;
    return await ctx.invokeNode({
      params: invocation.args,
      timeoutMs: invocation.timeoutMs,
      idempotencyKey: invocation.key,
    });
  };
  api.registerNodeInvokePolicy({
    commands: echoCommands.filter((command) => !captureCommands.includes(command)),
    defaultPlatforms: ["linux"],
    handle,
  });
  api.registerNodeInvokePolicy({ commands: captureCommands, dangerous: true, handle });

  for (const permission of ["read", "control", "observe"] as const) {
    const { name, label, description } = tools[permission];
    api.registerTool(
      {
        contextVersion: 2,
        create(context: EchoToolContext) {
          const agentId = context.agentId;
          if (
            !agentId ||
            !context.runId ||
            typeof context.isPrivateRequesterProfile !== "function"
          ) {
            return null;
          }
          let allowed: EchoAction[];
          try {
            const state = readState(api);
            const devices = authorizedDevices(state.registry, agentId).filter(
              (device) =>
                device.provider === provider && device.grants.get(agentId)?.has(permission),
            );
            const available = devices.flatMap((device) => {
              const binding = state.bindings.get(device.id);
              return binding && matchesDeviceBinding(context, binding) ? binding.commands : [];
            });
            allowed = (Object.keys(operations) as EchoAction[]).filter(
              (action) =>
                operations[action].permission === permission &&
                available.includes(operations[action].command),
            );
          } catch {
            return null;
          }
          if (!allowed.length) {
            return null;
          }
          return {
            name,
            label,
            description,
            parameters: echoToolParameters(allowed),
            async execute(toolCallId: string, raw: unknown, signal?: AbortSignal) {
              const action = parseEchoAction(raw);
              if (!action || !allowed.includes(action.action) || !context.runId || !toolCallId) {
                return jsonResult(deny("INVALID_REQUEST", "Invalid Echo device request."));
              }
              const command = operations[action.action].command;
              const requestTimeout = permission === "observe" ? 15_000 : timeoutMs;
              const authorize = () =>
                authorizeEchoCommand(api, context, action.device, permission, command);
              let selected: EchoBinding;
              try {
                signal?.throwIfAborted();
                selected = authorize();
              } catch (error) {
                if (signal?.aborted) {
                  throw error;
                }
                return jsonResult(
                  deny(
                    "NOT_AUTHORIZED",
                    "This Echo command is unavailable to the current requester.",
                  ),
                );
              }
              try {
                const key = createHash("sha256")
                  .update(JSON.stringify([context.runId, toolCallId, selected.nodeId, command]))
                  .digest("hex");
                const isCurrent = () => {
                  try {
                    return !signal?.aborted && authorize().nodeId === selected.nodeId;
                  } catch {
                    return false;
                  }
                };
                const result = await active.run(
                  {
                    nodeId: selected.nodeId,
                    command,
                    args: action.args,
                    key,
                    timeoutMs: requestTimeout,
                    isCurrent,
                    used: false,
                  },
                  () =>
                    api.runtime.nodes.invoke({
                      nodeId: selected.nodeId,
                      command,
                      params: action.args,
                      idempotencyKey: key,
                      sessionKey: context.sessionKey,
                      timeoutMs: requestTimeout,
                      signal,
                    }),
                );
                if (!isCurrent()) {
                  return jsonResult(
                    deny("NOT_AUTHORIZED", "The Echo permission changed during the request."),
                  );
                }
                const payload = echoPayload(result);
                if (action.action === "capture_audio" || action.action === "capture_photo") {
                  return await saveEchoCapture(
                    api,
                    action.device,
                    decodeEchoCapture(action.action, payload, action.args.durationSeconds),
                    isCurrent,
                  );
                }
                if (
                  !payload ||
                  typeof payload !== "object" ||
                  Buffer.byteLength(JSON.stringify(payload)) > maxResultBytes
                ) {
                  throw new Error("Invalid or oversized Echo result payload");
                }
                return jsonResult({ ok: true, device: action.device, result: payload });
              } catch (error) {
                if (signal?.aborted) {
                  throw error;
                }
                return jsonResult(
                  deny(
                    "UNAVAILABLE",
                    "The Echo request could not be confirmed. Check its connection, device grants and native command approval before retrying.",
                  ),
                );
              }
            },
          };
        },
      },
      { name, optional: true },
    );
  }
}

function authorizeEchoCommand(
  api: OpenClawPluginApi,
  context: EchoToolContext,
  deviceId: string,
  permission: EchoPermission,
  command: EchoCommand,
) {
  context.assertInvocationCurrent();
  const state = readState(api);
  assertDeviceGrant(state.registry, context.agentId, deviceId, provider, permission);
  const binding = state.bindings.get(deviceId);
  if (!binding || !binding.commands.includes(command) || !matchesDeviceBinding(context, binding)) {
    throw new Error("The Echo device command is not available to this requester");
  }
  return binding;
}
