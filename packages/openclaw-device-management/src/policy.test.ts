import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDeviceGrant, authorizedDevices, loadProviderMetadata, parseDeviceRegistry, publicDevice, registryFromOpenClawConfig } from "./policy.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

const providers = Object.fromEntries(["google-tv", "denon", "fritz", "govee"].map((provider) => [provider, fileURLToPath(new URL(`../../openclaw-${provider}/`, import.meta.url))]));
const config = { providers, devices: [{
  id: "wohnzimmer_tv", name: "Fernseher", kind: "television", siteId: "home_site", room: "Wohnzimmer",
  provider: "google-tv",
  grants: { example_owner: ["read", "control", "observe"], example_member: ["read", "control"] },
}] };

describe("device management policy", () => {
  it("exposes only assigned devices and tools", () => {
    const registry = parseDeviceRegistry(config);
    expect(authorizedDevices(registry, "example_owner")).toHaveLength(1);
    expect(authorizedDevices(registry, "example_other")).toHaveLength(0);
    expect(publicDevice(registry.get("wohnzimmer_tv")!, "example_member").tools).toEqual({ status: "google_tv_status", control: "google_tv_control" });
    expect(registry.get("wohnzimmer_tv")!.capabilities).toContain("remote");
    expect(() => assertDeviceGrant(registry, "example_member", "wohnzimmer_tv", "google-tv", "observe")).toThrow(/not available/);
    expect(() => assertDeviceGrant(registry, "example_other", "wohnzimmer_tv", "google-tv", "read")).toThrow(/not available/);
    expect(() => assertDeviceGrant(registry, "example_owner", "wohnzimmer_tv", "denon", "control")).toThrow(/not available/);
  });

  it("reads the one canonical plugin entry and fails closed", () => {
    expect(registryFromOpenClawConfig({ plugins: { entries: { "device-management": { config }, "google-tv": { config: { devices: [{ id: "wohnzimmer_tv" }] } } } } }).size).toBe(1);
    expect(() => registryFromOpenClawConfig({ plugins: { entries: {} } })).toThrow();
    expect(() => registryFromOpenClawConfig({ plugins: { entries: { "device-management": { enabled: false, config } } } })).toThrow();
    expect(() => registryFromOpenClawConfig({ plugins: { entries: { "device-management": { config } } } })).toThrow(/not enabled/);
    expect(() => registryFromOpenClawConfig({ plugins: { entries: { "device-management": { config }, "google-tv": { config: { devices: [{ id: "different" }] } } } } })).toThrow(/not configured/);
  });

  it("rejects duplicate identities and invalid grants", () => {
    expect(() => parseDeviceRegistry({ providers, devices: [config.devices[0], config.devices[0]] })).toThrow(/duplicate/);
    expect(() => parseDeviceRegistry({ providers, devices: [{ ...config.devices[0], provider: "fritz", grants: { example_other: ["observe"] } }] })).toThrow(/corresponding/);
    expect(() => parseDeviceRegistry({ ...config, devices: [{ ...config.devices[0], tools: { status: "custom" } }] })).toThrow(/not supported/);
    expect(() => parseDeviceRegistry({ ...config, devices: [{ ...config.devices[0], capabilities: ["custom"] }] })).toThrow(/not supported/);
  });

  it("publishes a receiver station catalog only to readers", () => {
    const registry = parseDeviceRegistry({ providers, devices: [{ ...config.devices[0], kind: "media_receiver", provider: "denon", grants: { example_owner: ["read", "control"], example_member: ["control"] } }] });
    expect(publicDevice(registry.get("wohnzimmer_tv")!, "example_owner").tools).toMatchObject({ stations: "denon_dab_stations" });
    expect(publicDevice(registry.get("wohnzimmer_tv")!, "example_member").tools).not.toHaveProperty("stations");
  });

  it("requires plugin metadata to agree with the native manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "device-metadata-test-"));
    temporary.push(root);
    const metadata = { version: 1, provider: "example", capabilities: ["power"], tools: { status: "example_status" } };
    writeFileSync(join(root, "device-provider.json"), JSON.stringify(metadata));
    writeFileSync(join(root, "openclaw.plugin.json"), JSON.stringify({ id: "example", contracts: { tools: ["unrelated_tool"] } }));
    expect(() => loadProviderMetadata("example", root)).toThrow(/undeclared tool/);
    writeFileSync(join(root, "openclaw.plugin.json"), JSON.stringify({ id: "example", contracts: { tools: ["example_status"] } }));
    expect(loadProviderMetadata("example", root).tools.status).toBe("example_status");
    expect(() => loadProviderMetadata("different", root)).toThrow(/identity/);
    writeFileSync(join(root, "device-provider.json"), JSON.stringify({ ...metadata, version: 2 }));
    expect(() => loadProviderMetadata("example", root)).toThrow(/version/);
    writeFileSync(join(root, "device-provider.json"), " ".repeat(65537));
    expect(() => loadProviderMetadata("example", root)).toThrow(/invalid device-provider/);
    expect(() => loadProviderMetadata("example", "relative/path")).toThrow(/absolute/);
  });
});
