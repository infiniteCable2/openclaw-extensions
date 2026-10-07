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
