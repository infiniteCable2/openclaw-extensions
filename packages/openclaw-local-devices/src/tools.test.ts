import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createToolsForAgent, parseDeviceAction } from "./tools.js";
import { buildDabCatalog } from "./dab-catalog.js";
import { DenonCeolBackend } from "./denon.js";
import type { DeviceBackend, LocalDevicesConfig } from "./types.js";

const config: LocalDevicesConfig = {
  allowedAgentIds: new Set(["steffen", "astrid"]),
  requestTimeoutMs: 5000,
};

describe("local device tools", () => {
  it("is absent outside the explicit agent allowlist", () => {
    expect(createToolsForAgent(config, new Map(), "steffen")?.map((tool) => tool.name)).toEqual([
      "local_device_status",
      "local_device_dab_stations",
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
    expect(parseDeviceAction({ action: "set_volume", volume: 10, via: "upnp" })).toEqual({ type: "set_volume", volume: 10, via: "upnp" });
    expect(parseDeviceAction({ action: "select_dab_station", station: "dab_001" })).toEqual({ type: "select_dab_station", station: "dab_001" });
    expect(parseDeviceAction({ action: "refresh_dab_stations" })).toEqual({ type: "refresh_dab_stations" });
    expect(() => parseDeviceAction({ action: "select_dab_station" })).toThrow(/station/);
    expect(() => parseDeviceAction({ action: "station_next", via: "heos" })).toThrow(/via/);
    expect(() => parseDeviceAction({ action: "set_volume", volume: 10, via: "heos" })).toThrow(/via/);
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

  it("lists a linked TV without claiming live state or duplicating control", async () => {
    const withTv: LocalDevicesConfig = {
      ...config,
      linkedDevices: [{
        id: "wohnzimmer_tv", name: "Fernseher (Wohnzimmer)", provider: "google-tv",
        statusTool: "google_tv_status", controlTool: "google_tv_control",
        observeTool: "google_tv_observe", guideTool: "google_tv_guide",
      }],
    };
    const lamp = { id: "lamp", name: "Lamp", provider: "govee" as const, available: true, power: "on" as const };
    const backend: DeviceBackend = { provider: "govee", status: vi.fn(async () => lamp), control: vi.fn(async () => lamp) };
    const backends = new Map([["lamp", backend]]);
    const steffen = createToolsForAgent(withTv, backends, "steffen") ?? [];
    const astrid = createToolsForAgent(withTv, backends, "astrid") ?? [];
    expect(createToolsForAgent(withTv, new Map(), "bodo")).toBeNull();
    const reference = {
      id: "wohnzimmer_tv", name: "Fernseher (Wohnzimmer)", provider: "google-tv",
      kind: "tool_reference", state: "not_queried",
      tools: { status: "google_tv_status", control: "google_tv_control", observe: "google_tv_observe", guide: "google_tv_guide" },
    };
    for (const tools of [steffen, astrid]) {
      const status = tools.find((tool) => tool.name === "local_device_status") as AnyAgentTool;
      const all = await status.execute("call-1", {});
      const selected = await status.execute("call-2", { device: "wohnzimmer_tv" });
      expect(all.details).toEqual({ ok: true, devices: [lamp, reference] });
      expect(selected.details).toEqual({ ok: true, devices: [reference] });
      const control = tools.find((tool) => tool.name === "local_device_control") as AnyAgentTool;
      expect((await control.execute("call-3", { device: "wohnzimmer_tv", action: "turn_on" })).details).toMatchObject({
        ok: false, error: { code: "linked_device" },
      });
    }
  });

  it("reads a cached DAB list without contacting the receiver", async () => {
    const catalog = buildDabCatalog("127.0.0.1", ["ENERGY B", "Jazz"], 2, 0, true, 1234);
    const backend = new DenonCeolBackend(
      { id: "receiver", name: "Receiver", address: "127.0.0.1" },
      100,
      { lookup: vi.fn(async () => catalog), register: vi.fn(async () => undefined) },
    );
    const tools = createToolsForAgent(config, new Map([["receiver", backend]]), "steffen") ?? [];
    const tool = tools.find((candidate) => candidate.name === "local_device_dab_stations") as AnyAgentTool;
    const result = await tool.execute("call-2", { device: "receiver" });
    expect(result.details).toMatchObject({ ok: true, catalog: { state: "ready", stations: catalog.stations } });
  });
});
