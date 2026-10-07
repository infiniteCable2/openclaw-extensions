import { describe, expect, it, vi } from "vitest";
import { parseVoiceassistantConfig } from "./config.js";
import { createVoiceassistantDeviceTool } from "./device-tool.js";

const config = parseVoiceassistantConfig({
  nodeId: "a".repeat(64), agentId: "steffen", transcriptionProvider: "local-media",
});

describe("voiceassistant device tool", () => {
  it("is absent from every other agent's catalog", () => {
    expect(createVoiceassistantDeviceTool({ agentId: "astrid" } as never, config, () => undefined))
      .toBeNull();
  });

  it("allows bounded settings but requires explicit power confirmation", async () => {
    const deviceCommand = vi.fn(async () => ({ mode: "wake_word" }));
    const assertInvocationCurrent = vi.fn();
    const tool = createVoiceassistantDeviceTool(
      { agentId: "steffen", assertInvocationCurrent } as never,
      config,
      () => ({ deviceCommand }) as never,
    );
    expect(tool).not.toBeNull();
    await expect(tool!.execute("call", { action: "set_brightness", percent: 101 }))
      .rejects.toThrow("percent");
    await expect(tool!.execute("call", { action: "shutdown" }))
      .rejects.toThrow("authenticated owner");
    expect(deviceCommand).not.toHaveBeenCalled();
    await tool!.execute("call", { action: "set_brightness", percent: 20 });
    expect(deviceCommand).toHaveBeenCalledWith({
      action: "configure", brightnessPercent: 20,
    });
    expect(assertInvocationCurrent).toHaveBeenCalledOnce();
  });

  it("requires both owner context and confirmation before requesting power", async () => {
    const deviceCommand = vi.fn(async () => ({ accepted: true }));
    const tool = createVoiceassistantDeviceTool(
      { agentId: "steffen", senderIsOwner: true, assertInvocationCurrent: vi.fn() } as never,
      config,
      () => ({ deviceCommand }) as never,
    );
    await expect(tool!.execute("call", { action: "restart" })).rejects.toThrow("confirm");
    await tool!.execute("call", { action: "restart", confirm: true });
    expect(deviceCommand).toHaveBeenCalledWith({
      action: "power", operation: "restart", confirm: true,
    });
  });
});
