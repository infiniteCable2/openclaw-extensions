import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import plugin from "./index.js";

const registryConfig = { providers: { fritz: fileURLToPath(new URL("../../openclaw-fritz/", import.meta.url)) }, devices: [{
  id: "lamp", name: "Lampe auf dem Tisch", kind: "light", siteId: "astrid", room: "Wohnzimmer",
  provider: "fritz",
  grants: { steffen: ["read", "control"], astrid: ["read", "control"] },
}] };

describe("device inventory plugin entry", () => {
  it("registers an agent-scoped tool and follows current grants", async () => {
    const registrations: Array<{ factory: (context: unknown) => unknown; name: string }> = [];
    let current: unknown = { plugins: { entries: { "device-management": { config: registryConfig }, fritz: { config: { devices: [{ id: "lamp" }] } } } } };
    plugin.register({
      pluginConfig: registryConfig,
      runtime: { config: { current: () => current } },
      registerTool: (factory: unknown, options: { name: string }) => registrations.push({ factory: factory as (context: unknown) => unknown, name: options.name }),
    } as never);
    expect(registrations.map((item) => item.name)).toEqual(["device_inventory"]);
    const inventory = registrations[0]!.factory({ agentId: "steffen" }) as { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
    expect((await inventory.execute("call", {})).details).toMatchObject({ ok: true, devices: [{ id: "lamp", siteId: "astrid", kind: "light" }] });
    current = { plugins: { entries: { "device-management": { config: { ...registryConfig, devices: [{ ...registryConfig.devices[0], grants: { astrid: ["read", "control"] } }] } }, fritz: { config: { devices: [{ id: "lamp" }] } } } } };
    expect((await inventory.execute("call", {})).details).toMatchObject({ ok: true, devices: [] });
    expect(registrations[0]!.factory({ agentId: "bodo" })).toBeUndefined();
  });
});
