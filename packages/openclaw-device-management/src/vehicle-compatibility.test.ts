import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import plugin from "./index.js";
import { assertDeviceGrant, registryFromOpenClawConfig } from "./policy.js";

it("preserves both deployed vehicle sources and limits private profiles to their read tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "device-manager-vehicle-"));
  try {
    const providers = Object.fromEntries(["volkswagen", "smartcar"].map((provider) => {
      const directory = join(root, provider);
      mkdirSync(directory);
      const status = provider === "volkswagen" ? "volkswagen_vehicle" : "smartcar_vehicle";
      const brand = provider === "volkswagen" ? { statusByBrand: { cupra: "cupra_vehicle" } } : {};
      writeFileSync(join(directory, "device-provider.json"), JSON.stringify({
        version: 1, provider, capabilities: ["vehicle_status"], tools: { status }, ...brand,
      }));
      writeFileSync(join(directory, "openclaw.plugin.json"), JSON.stringify({
        id: provider,
        contracts: { tools: provider === "volkswagen" ? [status, "cupra_vehicle"] : [status] },
      }));
      return [provider, directory];
    }));
    const manager = { providers, devices: [{
      id: "fixture_car", name: "Fixture car", kind: "vehicle", siteId: "site", room: "Garage",
      provider: "volkswagen", additionalProviders: ["smartcar"], personalReadProfileId: "vehicle_profile",
      grants: { fixture_agent: ["read"] },
    }] };
    const config = { plugins: { entries: {
      "device-management": { config: manager },
      volkswagen: { config: { devices: [{ id: "fixture_car", brand: "cupra" }] } },
      smartcar: { config: { devices: [{ id: "fixture_car" }] } },
    } } };
    const registry = registryFromOpenClawConfig(config);
    expect(assertDeviceGrant(registry, "fixture_agent", "fixture_car", "smartcar", "read").id).toBe("fixture_car");
    expect(() => assertDeviceGrant(registry, "fixture_agent", "fixture_car", "smartcar", "control")).toThrow();
    const registrations: Array<{ create: (context: unknown) => unknown }> = [];
    plugin.register({ pluginConfig: manager, runtime: { config: { current: () => config } },
      registerTool: (factory: typeof registrations[number]) => registrations.push(factory),
    } as never);
    let admitted = true;
    const context = { agentId: "fixture_agent", assertInvocationCurrent() {},
      isPrivateRequesterProfile: (profile: string) => admitted && profile === "vehicle_profile" };
    const inventory = registrations[0]!.create(context) as {
      execute: (call: string, args: object) => Promise<{ details: unknown }>;
    };
    expect((await inventory.execute("read", {})).details).toMatchObject({ ok: true, devices: [{
      id: "fixture_car", permissions: ["read"], sources: [
        { provider: "volkswagen", tools: { status: "cupra_vehicle" } },
        { provider: "smartcar", tools: { status: "smartcar_vehicle" } },
      ],
    }] });
    admitted = false;
    expect((await inventory.execute("revoked", {})).details).toEqual({ ok: true, devices: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
