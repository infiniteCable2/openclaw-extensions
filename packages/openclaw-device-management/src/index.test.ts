import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import plugin from "./index.js";

const registryConfig = { providers: { fritz: fileURLToPath(new URL("../../openclaw-fritz/", import.meta.url)) }, devices: [{
  id: "lamp", name: "Lampe auf dem Tisch", kind: "light", siteId: "home_site", room: "Wohnzimmer",
  provider: "fritz",
  grants: { example_owner: ["read", "control"], example_member: ["read", "control"] },
}] };

describe("device inventory plugin entry", () => {
  it("registers an agent-scoped tool and follows current grants", async () => {
    const registrations: Array<{ create: (context: unknown) => unknown; name: string }> = [];
    let current: unknown = { plugins: { entries: { "device-management": { config: registryConfig }, fritz: { config: { devices: [{ id: "lamp" }] } } } } };
    plugin.register({
      pluginConfig: registryConfig,
      runtime: { config: { current: () => current } },
      registerTool: (factory: { create: (context: unknown) => unknown }, options: { name: string }) => registrations.push({ ...factory, name: options.name }),
    } as never);
    expect(registrations.map((item) => item.name)).toEqual(["device_inventory", "device_inventory_diagnostics"]);
    const authority = { agentId: "example_owner", assertInvocationCurrent: () => {} };
    const inventory = registrations[0]!.create(authority) as { execute: (id: string, params: unknown) => Promise<{ details: unknown }> };
    expect((await inventory.execute("call", {})).details).toMatchObject({
      ok: true, devices: [{ id: "lamp", siteId: "home_site", kind: "light", capabilities: [], tools: {} }],
    });
    expect(registrations[1]!.create(authority)).toBeUndefined();
    current = { plugins: { entries: { "device-management": { config: { ...registryConfig, devices: [{ ...registryConfig.devices[0], grants: { example_member: ["read", "control"] } }] } }, fritz: { config: { devices: [{ id: "lamp" }] } } } } };
    expect((await inventory.execute("call", {})).details).toMatchObject({ ok: true, devices: [] });
    expect(registrations[0]!.create({ agentId: "example_other" })).toBeUndefined();
  });
});
