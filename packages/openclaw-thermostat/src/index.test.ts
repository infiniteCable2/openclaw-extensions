import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const { withThermostat } = vi.hoisted(() => ({ withThermostat: vi.fn() }));
vi.mock("./mqtt.js", () => ({ withThermostat }));
vi.mock("openclaw/plugin-sdk/tool-plugin", () => ({
  defineToolPlugin: (plugin: unknown) => plugin,
}));

import plugin from "./index.js";

const pkg = fileURLToPath(new URL("../", import.meta.url));
function config(grants = ["read", "control"], ieeeAddress = "0x0011223344556677") {
  return {
    plugins: {
      entries: {
        "device-management": { config: {
          providers: { thermostat: pkg },
          devices: [{ id: "room_heater", name: "Radiator", kind: "thermostat", siteId: "example_site", room: "Study", provider: "thermostat", grants: { example_owner: grants } }],
        } },
        thermostat: { config: { devices: [{ id: "room_heater", ieeeAddress }] } },
      },
    },
  };
}

type Registration = {
  name: string;
  factory: (input: { api: OpenClawPluginApi; toolContext: { agentId?: string } }) => AnyAgentTool | undefined;
};
const registrations = (plugin as unknown as {
  tools: (register: (tool: Registration) => Registration) => Registration[];
}).tools((registration) => registration);

function setup(start = config()) {
  let current = start;
  const api = { config: start, runtime: { config: { current: () => current } } } as unknown as OpenClawPluginApi;
  function tool(name: string, agentId = "example_owner") {
    return registrations.find((entry) => entry.name === name)!.factory({ api, toolContext: { agentId } });
  }
  return { tool, replace: (next: ReturnType<typeof config>) => { current = next; } };
}

describe("managed thermostat tools", () => {
  it("exports read only for a read grant, and exposes no tools to an unassigned agent", () => {
    const { tool } = setup(config(["read"]));
    expect(tool("thermostat_status")).toBeDefined();
    expect(tool("thermostat_control")).toBeUndefined();
    expect(tool("thermostat_calibrate")).toBeUndefined();
    expect(tool("thermostat_status", "example_guest")).toBeUndefined();
  });

  it("checks a revoked grant again at execution before opening MQTT", async () => {
    withThermostat.mockClear();
    const { tool, replace } = setup();
    const control = tool("thermostat_control")!;
    replace(config(["read"]));
    const result = await control.execute("example_call", { device: "room_heater", action: "set_temperature", temperatureC: 23 });
    expect(JSON.stringify(result)).toContain("device_denied");
    expect(withThermostat).not.toHaveBeenCalled();
  });

  it("checks the IEEE assignment again before dispatch", async () => {
    const { tool, replace } = setup();
    withThermostat.mockImplementationOnce(async (_connection, _signal, authorize: () => void) => {
      replace(config(["read", "control"], "0x1111223344556677"));
      authorize();
    });
    const result = await tool("thermostat_control")!.execute("example_call", { action: "set_temperature", temperatureC: 23 });
    expect(JSON.stringify(result)).toContain("device_assignment_changed");
  });

  it("requires a separate explicit calibration call", async () => {
    withThermostat.mockClear();
    const { tool } = setup();
    const result = await tool("thermostat_calibrate")!.execute("example_call", { confirm: false });
    expect(JSON.stringify(result)).toContain("invalid_request");
    expect(withThermostat).not.toHaveBeenCalled();
  });
});
