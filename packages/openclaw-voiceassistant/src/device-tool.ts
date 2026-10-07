import { Type } from "typebox";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { VoiceassistantConfig } from "./config.js";
import type { VoiceassistantService } from "./service.js";

export function createVoiceassistantDeviceTool(
  context: OpenClawPluginToolContext<2>,
  config: VoiceassistantConfig,
  getService: () => VoiceassistantService | undefined,
) {
  if (context.agentId !== config.agentId) {
    return null;
  }
  return {
    name: "voiceassistant_device",
    label: "Voiceassistant device",
    description:
      "Read or adjust the paired voiceassistant Pi. Volume and LED brightness accept 0-100%. " +
      "Modes are wake_word, continuous and muted. A physical-button mute cannot be remotely undone. " +
      "Restart or shutdown only when the user explicitly requests that operation; shutdown may require physical power to restore.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"), Type.Literal("set_volume"), Type.Literal("set_brightness"),
        Type.Literal("set_mode"), Type.Literal("restart"), Type.Literal("shutdown"),
      ]),
      percent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      mode: Type.Optional(Type.Union([
        Type.Literal("wake_word"), Type.Literal("continuous"), Type.Literal("muted"),
      ])),
      confirm: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, raw: unknown) {
      const params = raw as Record<string, unknown>;
      const action = params.action;
      let request: Record<string, unknown>;
      if (action === "status") {
        request = { action: "status" };
      } else if (action === "set_volume" || action === "set_brightness") {
        if (!Number.isInteger(params.percent) || Number(params.percent) < 0 || Number(params.percent) > 100) {
          throw new Error("percent must be an integer from 0 to 100");
        }
        request = { action: "configure",
          [action === "set_volume" ? "volumePercent" : "brightnessPercent"]: params.percent };
      } else if (action === "set_mode") {
        if (!["wake_word", "continuous", "muted"].includes(String(params.mode))) {
          throw new Error("invalid voiceassistant mode");
        }
        request = { action: "configure", mode: params.mode };
      } else if (action === "restart" || action === "shutdown") {
        if (context.senderIsOwner !== true) {
          throw new Error("device power operations require an authenticated owner turn");
        }
        if (params.confirm !== true) {
          throw new Error("explicit confirm=true is required for device power operations");
        }
        request = { action: "power", operation: action, confirm: true };
      } else {
        throw new Error("invalid voiceassistant action");
      }
      context.assertInvocationCurrent();
      const service = getService();
      if (!service) {
        throw new Error("voiceassistant service is unavailable");
      }
      const result = await service.deviceCommand(request);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
    },
  };
}
