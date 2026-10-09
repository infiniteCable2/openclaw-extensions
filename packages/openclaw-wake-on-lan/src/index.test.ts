import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

const providerConfig = { devices: [{ id: "computer_owner", macAddress: "02:ab:cd:00:00:01", broadcastAddress: "192.168.50.255" }] };
const config = { plugins: { entries: {
  "wake-on-lan": { config: providerConfig },
  "device-management": { config: {
    providers: { "wake-on-lan": fileURLToPath(new URL("../", import.meta.url)) },
    devices: [{ id: "computer_owner", name: "Example computer", kind: "computer", siteId: "home_site", room: "Test room", provider: "wake-on-lan", grants: { example_owner: ["read", "control"] } }],
  } },
} } };

describe("native Wake-on-LAN plugin registration", () => {
  it("advertises optional tools only for the assigned agent", async () => {
    const registrations: Array<{ factory: (context: unknown) => unknown; name: string }> = [];
    plugin.register({
      config, pluginConfig: providerConfig, runtime: { config: { current: () => config } },
      registerTool: (factory: unknown, options: { name: string }) => registrations.push({ factory: factory as (context: unknown) => unknown, name: options.name }),
    } as never);
    expect(registrations.map((registration) => registration.name)).toEqual(["wake_on_lan_status", "wake_on_lan"]);
    for (const registration of registrations) {
      expect(registration.factory({ agentId: "example_owner" })).toBeDefined();
      for (const agentId of ["example_member", "example_other", "ops", undefined]) expect(registration.factory({ agentId })).toBeUndefined();
    }
  });
});
