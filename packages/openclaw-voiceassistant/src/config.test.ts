import { describe, expect, it } from "vitest";
import { parseVoiceassistantConfig } from "./config.js";

const nodeId = "a".repeat(64);

describe("voiceassistant config", () => {
  it("binds exactly one node and agent with read-only tools by default", () => {
    const config = parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
    });
    expect(config.nodeId).toBe(nodeId);
    expect(config.profile.toolPolicy).toBe("safe-read-only");
    expect(config.responseStreaming).toBe("sentence");
    expect(config.profile).not.toHaveProperty("agentStreamParams");
  });

  it("keeps voice overrides in the selected agent profile", () => {
    const config = parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
      agentProfiles: {
        steffen: { toolPolicy: "owner", agentThinkingLevel: "off", speakCommentary: true },
        bodo: { agentThinkingLevel: "high" },
      },
    });
    expect(config.profile).toEqual({
      toolPolicy: "owner", agentThinkingLevel: "off", speakCommentary: true,
    });
  });

  it("keeps a fresh service-tier override with the selected voice profile", () => {
    const agentStreamParams = { serviceTier: "priority" };
    const config = parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
      agentProfiles: {
        steffen: { agentThinkingLevel: "medium", agentStreamParams },
        bodo: { agentStreamParams: { serviceTier: "default" } },
      },
    });
    expect(config.profile.agentThinkingLevel).toBe("medium");
    expect(config.profile.agentStreamParams).toEqual({ serviceTier: "priority" });
    expect(config.profile.agentStreamParams).not.toBe(agentStreamParams);
    if (config.profile.agentStreamParams) {
      config.profile.agentStreamParams.serviceTier = "default";
    }
    expect(agentStreamParams.serviceTier).toBe("priority");
  });

  it.each(["auto", "default", "flex", "priority"])("accepts the native %s tier", (serviceTier) => {
    const config = parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
      agentProfiles: { steffen: { agentStreamParams: { serviceTier } } },
    });
    expect(config.profile.agentStreamParams).toEqual({ serviceTier });
  });

  it.each([
    null, [], "priority", 1,
    { serviceTier: "fast" }, { serviceTier: "ultrafast" }, { serviceTier: 1 },
    { serviceTier: null }, { serviceTier: "priority", fastMode: true },
    { apiKey: "synthetic" }, { temperature: 0 },
  ].map((agentStreamParams) => ({ agentStreamParams })))("rejects malformed or unsupported stream params %j", ({ agentStreamParams }) => {
    expect(() => parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
      agentProfiles: { steffen: { agentStreamParams } },
    })).toThrow(/agentStreamParams/);
  });

  it("rejects commentary without sentence streaming", () => {
    expect(() => parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
      responseStreaming: "off", agentProfiles: { steffen: { speakCommentary: true } },
    })).toThrow(/commentary/);
  });

  it("rejects any imprecise node binding", () => {
    expect(() => parseVoiceassistantConfig({
      nodeId: "voiceassistant01", agentId: "steffen", transcriptionProvider: "local-media",
    })).toThrow(/nodeId/);
  });
});
