import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { parseDeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import { createGoveeTools } from "./tools.js";

const providers = { govee: fileURLToPath(new URL("../", import.meta.url)) };
const allowed = parseDeviceRegistry({ providers, devices: [{
  id: "light", name: "Licht am Sofa", kind: "light", siteId: "astrid", room: "Wohnzimmer", provider: "govee",
  grants: { steffen: ["read", "control"], astrid: ["read", "control"] },
}] });
const revoked = parseDeviceRegistry({ providers, devices: [{
  id: "light", name: "Licht am Sofa", kind: "light", siteId: "astrid", room: "Wohnzimmer", provider: "govee",
  grants: { astrid: ["read", "control"] },
}] });

describe("Govee device grants", () => {
  it("does not send a control command after an agent grant is revoked", async () => {
    const tools = createGoveeTools({ devices: [{ id: "light", name: "light", address: "192.168.1.10" }], requestTimeoutMs: 5000 }, allowed, "steffen", () => revoked);
    const control = tools.find((tool) => tool.name === "govee_control")!;
    expect((await control.execute("test", { device: "light", action: "turn_on" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    const status = tools.find((tool) => tool.name === "govee_status")!;
    expect((await status.execute("test", {})).details).toMatchObject({ ok: true, devices: [] });
  });
});
