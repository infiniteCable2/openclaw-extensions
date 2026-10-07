import { describe, expect, it } from "vitest";
import { parseDeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import { createFritzTools } from "./tools.js";

const registry = parseDeviceRegistry({ devices: [{
  id: "lamp", name: "Lampe auf dem Tisch", kind: "light", siteId: "home_site", room: "Wohnzimmer", provider: "fritz",
  capabilities: ["power"], tools: { status: "fritz_status", control: "fritz_control" },
  grants: { example_owner: ["read", "control"] },
}] });

describe("FRITZ device grants", () => {
  it("does not contact the FRITZ box for an unassigned agent", async () => {
    const tools = createFritzTools({ devices: [{ id: "lamp", name: "lamp", uid: "123" }], baseUrl: "http://fritz.box", username: "test", password: "synthetic", requestTimeoutMs: 5000 }, registry, "example_other");
    expect((await tools.find((tool) => tool.name === "fritz_status")!.execute("test", {})).details).toMatchObject({ ok: true, devices: [] });
    expect((await tools.find((tool) => tool.name === "fritz_control")!.execute("test", { device: "lamp", action: "turn_on" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
  });
});
