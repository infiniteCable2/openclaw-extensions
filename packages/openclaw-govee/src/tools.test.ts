import { describe, expect, it } from "vitest";
import { parseDeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import { createGoveeTools } from "./tools.js";

const allowed = parseDeviceRegistry({ devices: [{
  id: "light", name: "Licht am Sofa", kind: "light", siteId: "home_site", room: "Wohnzimmer", provider: "govee",
  capabilities: ["power", "color"], tools: { status: "govee_status", control: "govee_control" },
  grants: { example_owner: ["read", "control"], example_member: ["read", "control"] },
}] });
const revoked = parseDeviceRegistry({ devices: [{
  id: "light", name: "Licht am Sofa", kind: "light", siteId: "home_site", room: "Wohnzimmer", provider: "govee",
  capabilities: ["power"], tools: { status: "govee_status", control: "govee_control" },
  grants: { example_member: ["read", "control"] },
}] });

describe("Govee device grants", () => {
  it("does not send a control command after an agent grant is revoked", async () => {
    const tools = createGoveeTools({ devices: [{ id: "light", name: "light", address: "192.168.1.10" }], requestTimeoutMs: 5000 }, allowed, "example_owner", () => revoked);
    const control = tools.find((tool) => tool.name === "govee_control")!;
    expect((await control.execute("test", { device: "light", action: "turn_on" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    const status = tools.find((tool) => tool.name === "govee_status")!;
    expect((await status.execute("test", {})).details).toMatchObject({ ok: true, devices: [] });
  });
});
