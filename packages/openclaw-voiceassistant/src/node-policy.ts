import type { OpenClawPluginNodeInvokePolicy } from "openclaw/plugin-sdk/plugin-entry";
import type { VoiceassistantConfig } from "./config.js";

export const VOICEASSISTANT_COMMAND = "voiceassistant.audio";

function failed(message: string) {
  return { ok: false as const, code: "INVALID_REQUEST", message };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function bridgeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function createVoiceassistantNodePolicy(
  config: VoiceassistantConfig,
): OpenClawPluginNodeInvokePolicy {
  return {
    commands: [VOICEASSISTANT_COMMAND],
    dangerous: true,
    async handle(ctx) {
      if (ctx.nodeId !== config.nodeId || ctx.node?.deviceFamily !== "voiceassistant") {
        return failed("voiceassistant node is not bound to this agent");
      }
      const raw = record(ctx.params);
      const action = raw.action;
      if (action === "status" || action === "holdListening" || action === "start") {
        return await ctx.invokeNode({ params: { action } });
      }
      if (action === "configure") {
        const settings = ["mode", "volumePercent", "brightnessPercent"].filter((key) => raw[key] !== undefined);
        if (settings.length !== 1) {
          return failed("configure requires exactly one setting");
        }
        const key = settings[0];
        const value = raw[key];
        if (key === "mode" ? !["muted", "wake_word", "continuous"].includes(String(value)) :
          !Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) {
          return failed("invalid device setting");
        }
        return await ctx.invokeNode({ params: { action, [key]: value } });
      }
      if (action === "power") {
        if (!["restart", "shutdown"].includes(String(raw.operation)) || raw.confirm !== true) {
          return failed("power operation requires explicit confirmation");
        }
        return await ctx.invokeNode({ params: { action, operation: raw.operation, confirm: true } });
      }
      if (action === "stop") {
        if (raw.bridgeId !== undefined && !bridgeId(raw.bridgeId)) {
          return failed("invalid bridgeId");
        }
        return await ctx.invokeNode({ params: { action, ...(raw.bridgeId ? { bridgeId: raw.bridgeId } : {}) } });
      }
      if (!bridgeId(raw.bridgeId)) {
        return failed("bridgeId required");
      }
      if (action === "setActivity") {
        if (!["listening", "sensing", "hearing", "processing", "speaking"].includes(String(raw.activity))) {
          return failed("invalid conversation activity");
        }
        return await ctx.invokeNode({ params: { action, bridgeId: raw.bridgeId, activity: raw.activity } });
      }
      if (action === "pullAudio") {
        const timeoutMs = raw.timeoutMs ?? 250;
        if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 0 || Number(timeoutMs) > 250) {
          return failed("invalid pull timeout");
        }
        return await ctx.invokeNode({ params: { action, bridgeId: raw.bridgeId, timeoutMs } });
      }
      if (action === "pushAudio") {
        if (typeof raw.base64 !== "string" || raw.base64.length > 1_000_000 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64)) {
          return failed("invalid audio payload");
        }
        if (raw.outputGeneration !== undefined &&
          (!Number.isSafeInteger(raw.outputGeneration) || Number(raw.outputGeneration) < 0)) {
          return failed("invalid output generation");
        }
        return await ctx.invokeNode({ params: {
          action, bridgeId: raw.bridgeId, base64: raw.base64,
          ...(raw.outputGeneration !== undefined ? { outputGeneration: raw.outputGeneration } : {}),
        } });
      }
      if (action === "clearAudio") {
        if (raw.outputGeneration !== undefined &&
          (!Number.isSafeInteger(raw.outputGeneration) || Number(raw.outputGeneration) < 0)) {
          return failed("invalid output generation");
        }
        return await ctx.invokeNode({ params: {
          action, bridgeId: raw.bridgeId,
          ...(raw.outputGeneration !== undefined ? { outputGeneration: raw.outputGeneration } : {}),
        } });
      }
      return failed("unsupported voiceassistant action");
    },
  };
}
