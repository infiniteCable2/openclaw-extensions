import { describe, expect, it, vi } from "vitest";
import { parseDeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import { createDenonTools } from "./tools.js";

const registry = parseDeviceRegistry({ devices: [{
  id: "receiver", name: "Receiver", kind: "media_receiver", siteId: "astrid", room: "Wohnzimmer", provider: "denon",
  capabilities: ["power", "dab"], tools: { status: "denon_status", control: "denon_control" },
  grants: { steffen: ["read", "control"] },
}] });

describe("Denon device grants", () => {
  it("blocks DAB cache reads and controls for an unassigned agent", async () => {
    const lookup = vi.fn();
    const tools = createDenonTools({ devices: [{ id: "receiver", name: "receiver", address: "192.168.1.11" }], requestTimeoutMs: 5000 }, registry, "bodo", { lookup, register: vi.fn() });
    expect((await tools.find((tool) => tool.name === "denon_dab_stations")!.execute("test", { device: "receiver" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    expect((await tools.find((tool) => tool.name === "denon_control")!.execute("test", { device: "receiver", action: "turn_on" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    expect(lookup).not.toHaveBeenCalled();
  });
});
