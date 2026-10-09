import { assertDeviceGrant, authorizedDevices, DevicePolicyError, registryFromOpenClawConfig, type DeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { wakeOnLanConfigFromOpenClawConfig, type WakeOnLanConfig, type WakeOnLanDevice } from "./config.js";
import { WakeOnLanError } from "./errors.js";
import { sendWakePacket } from "./wake.js";

export type WakeOnLanState = { config: WakeOnLanConfig; registry: DeviceRegistry };
export const statusSchema = { type: "object", additionalProperties: false, properties: {
  device: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
} } satisfies AnyAgentTool["parameters"];
export const wakeSchema = { ...statusSchema, required: ["device"] } satisfies AnyAgentTool["parameters"];

export function stateFromOpenClawConfig(raw: unknown): WakeOnLanState {
  const registry = registryFromOpenClawConfig(raw);
  const config = wakeOnLanConfigFromOpenClawConfig(raw);
  for (const target of config.devices) {
    if (registry.get(target.id)?.provider !== "wake-on-lan") throw new WakeOnLanError("invalid_config");
  }
  return { config, registry };
}

function requestedDevice(params: unknown, required: boolean): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new WakeOnLanError("invalid_request");
  const input = params as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "device")) throw new WakeOnLanError("invalid_request");
  if (input.device === undefined && !required) return undefined;
  if (typeof input.device !== "string" || input.device.trim() !== input.device || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.device)) throw new WakeOnLanError("invalid_request");
  return input.device;
}

function failure(error: unknown) {
  return jsonResult({ ok: false, error: { code: error instanceof WakeOnLanError || error instanceof DevicePolicyError ? error.code : "wake_send_failed" } });
}

export function createWakeOnLanTools(
  agentId: string,
  currentState: () => WakeOnLanState,
  sender: typeof sendWakePacket = sendWakePacket,
): AnyAgentTool[] {
  return [
    {
      name: "wake_on_lan_status", label: "Wake on LAN Status",
      description: "Read configured WoL capability for assigned devices without network traffic. readyToSend is configuration readiness, not proof of hardware support or power state. Use device_inventory for names and locations.",
      parameters: statusSchema,
      execute: async (_callId, params) => {
        try {
          const requested = requestedDevice(params, false);
          const state = currentState();
          if (requested) assertDeviceGrant(state.registry, agentId, requested, "wake-on-lan", "read");
          const targets = new Set(state.config.devices.map((device) => device.id));
          const devices = authorizedDevices(state.registry, agentId).filter((device) => device.provider === "wake-on-lan" && device.grants.get(agentId)?.has("read") && targets.has(device.id) && (!requested || requested === device.id));
          return jsonResult({ ok: true, devices: devices.map((device) => ({ id: device.id, readyToSend: true, online: "unknown" })) });
        } catch (error) { return failure(error); }
      },
    },
    {
      name: "wake_on_lan", label: "Wake on LAN",
      description: "Send one magic packet to an assigned configured device. Arguments accept only its device ID, never MAC/IP/port. wakeSent means local UDP submission, not confirmed wake or readiness. Do not automatically retry an ambiguous timeout or error. This does not shut down or restart computers.",
      parameters: wakeSchema,
      execute: async (_callId, params, signal) => {
        try {
          const id = requestedDevice(params, true)!;
          const targetForState = (state: WakeOnLanState): WakeOnLanDevice => {
            assertDeviceGrant(state.registry, agentId, id, "wake-on-lan", "control");
            const target = state.config.devices.find((device) => device.id === id);
            if (!target) throw new WakeOnLanError("invalid_config");
            return target;
          };
          const initial = currentState();
          targetForState(initial);
          await sender(() => targetForState(currentState()), { timeoutMs: initial.config.requestTimeoutMs, signal });
          return jsonResult({ ok: true, device: { id, wakeSent: true, confirmed: false, online: "unknown" } });
        } catch (error) { return failure(error); }
      },
    },
  ];
}
