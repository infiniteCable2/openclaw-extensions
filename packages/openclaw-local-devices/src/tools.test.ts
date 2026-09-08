import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createToolsForAgent, parseDeviceAction } from "./tools.js";
import type { DeviceBackend, LocalDevicesConfig } from "./types.js";

const config: LocalDevicesConfig = {
  allowedAgentIds: new Set(["steffen", "astrid"]),
  requestTimeoutMs: 5000,
};

describe("local device tools", () => {
  it("is absent outside the explicit agent allowlist", () => {
    expect(createToolsForAgent(config, new Map(), "steffen")?.map((tool) => tool.name)).toEqual([
      "local_device_status",
      "local_device_control",
    ]);
    expect(createToolsForAgent(config, new Map(), "bodo")).toBeNull();
    expect(createToolsForAgent(config, new Map(), "ops")).toBeNull();
    expect(createToolsForAgent(config, new Map(), undefined)).toBeNull();
  });

  it("requires complete action-specific arguments", () => {
    expect(parseDeviceAction({ action: "turn_off" })).toEqual({ type: "turn_off" });
    expect(() => parseDeviceAction({ action: "set_color", red: 1, green: 2 })).toThrow(/blue/);
    expect(() => parseDeviceAction({ action: "set_brightness", brightness: 0 })).toThrow(/1 to 100/);
  });

  it("returns projected status from a configured backend", async () => {
    const status = {
      id: "lamp",
      name: "Lamp",
      provider: "govee" as const,
      available: true,
      power: "on" as const,
    };
    const backend: DeviceBackend = {
      provider: "govee",
      status: vi.fn(async () => status),
      control: vi.fn(async () => status),
    };
    const tools = createToolsForAgent(config, new Map([["lamp", backend]]), "astrid") ?? [];
    const tool = tools.find((candidate) => candidate.name === "local_device_status") as AnyAgentTool;
    const result = await tool.execute("call-1", { device: "lamp" });

    expect(result.details).toEqual({ ok: true, devices: [status] });
  });
});
