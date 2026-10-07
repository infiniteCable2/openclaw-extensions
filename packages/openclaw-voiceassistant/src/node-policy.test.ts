import { describe, expect, it, vi } from "vitest";
import { parseVoiceassistantConfig } from "./config.js";
import { createVoiceassistantNodePolicy, VOICEASSISTANT_COMMAND } from "./node-policy.js";

const nodeId = "a".repeat(64);
const config = parseVoiceassistantConfig({ nodeId, agentId: "steffen", transcriptionProvider: "local-media" });
const policy = createVoiceassistantNodePolicy(config);

function context(overrides: Record<string, unknown> = {}) {
  return {
    nodeId, command: VOICEASSISTANT_COMMAND,
    node: { nodeId, deviceFamily: "voiceassistant" },
    params: { action: "status" },
    invokeNode: vi.fn(async ({ params }: { params?: unknown }) => ({ ok: true as const, payload: params })),
    ...overrides,
  };
}

describe("voiceassistant node policy", () => {
  it("requires the exact configured identity and family", async () => {
    expect((await policy.handle(context({ nodeId: "b".repeat(64) }) as never)).ok).toBe(false);
    expect((await policy.handle(context({ node: { nodeId, deviceFamily: "linux" } }) as never)).ok).toBe(false);
    const approved = context();
    expect((await policy.handle(approved as never)).ok).toBe(true);
  });

  it("strips unexpected arguments and rejects unbounded payloads", async () => {
    const request = context({ params: { action: "start", systemRun: true } });
    await policy.handle(request as never);
    expect(request.invokeNode).toHaveBeenCalledWith({ params: { action: "start" } });
    const bad = context({ params: { action: "pushAudio", bridgeId: "b".repeat(32), base64: "!" } });
    expect((await policy.handle(bad as never)).ok).toBe(false);
  });

  it("preserves the audio output generation fence", async () => {
    const request = context({ params: {
      action: "clearAudio", bridgeId: "b".repeat(32), outputGeneration: 3,
    } });
    await policy.handle(request as never);
    expect(request.invokeNode).toHaveBeenCalledWith({ params: {
      action: "clearAudio", bridgeId: "b".repeat(32), outputGeneration: 3,
    } });
  });

  it("limits device settings and power to the paired voiceassistant", async () => {
    const valid = context({ params: { action: "configure", brightnessPercent: 20, injected: true } });
    expect((await policy.handle(valid as never)).ok).toBe(true);
    expect(valid.invokeNode).toHaveBeenCalledWith({ params: {
      action: "configure", brightnessPercent: 20,
    } });
    for (const params of [
      { action: "configure", brightnessPercent: 101 },
      { action: "configure", brightnessPercent: 20, volumePercent: 30 },
      { action: "power", operation: "shutdown" },
      { action: "power", operation: "sleep", confirm: true },
    ]) {
      expect((await policy.handle(context({ params }) as never)).ok).toBe(false);
    }
    const approved = context({ params: { action: "power", operation: "restart", confirm: true } });
    expect((await policy.handle(approved as never)).ok).toBe(true);
    expect(approved.invokeNode).toHaveBeenCalledWith({ params: {
      action: "power", operation: "restart", confirm: true,
    } });
  });

  it("sends only bounded activity for the current bridge", async () => {
    const bridgeId = "b".repeat(32);
    const valid = context({ params: { action: "setActivity", bridgeId, activity: "processing" } });
    expect((await policy.handle(valid as never)).ok).toBe(true);
    expect(valid.invokeNode).toHaveBeenCalledWith({ params: {
      action: "setActivity", bridgeId, activity: "processing",
    } });
    expect((await policy.handle(context({ params: {
      action: "setActivity", bridgeId, activity: "recording",
    } }) as never)).ok).toBe(false);
  });
});
