import { describe, expect, it } from "vitest";
import { assertDeviceGrant, authorizedDevices, parseDeviceRegistry, publicDevice, registryFromOpenClawConfig } from "./policy.js";

const config = { devices: [{
  id: "wohnzimmer_tv", name: "Fernseher", kind: "television", siteId: "astrid", room: "Wohnzimmer",
  provider: "google-tv", capabilities: ["power", "remote", "observe"],
  tools: { status: "google_tv_status", control: "google_tv_control", observe: "google_tv_observe" },
  grants: { steffen: ["read", "control", "observe"], astrid: ["read", "control"] },
}] };

describe("device management policy", () => {
  it("exposes only assigned devices and tools", () => {
    const registry = parseDeviceRegistry(config);
    expect(authorizedDevices(registry, "steffen")).toHaveLength(1);
    expect(authorizedDevices(registry, "bodo")).toHaveLength(0);
    expect(publicDevice(registry.get("wohnzimmer_tv")!, "astrid").tools).toEqual({ status: "google_tv_status", control: "google_tv_control" });
    expect(() => assertDeviceGrant(registry, "astrid", "wohnzimmer_tv", "google-tv", "observe")).toThrow(/not available/);
    expect(() => assertDeviceGrant(registry, "bodo", "wohnzimmer_tv", "google-tv", "read")).toThrow(/not available/);
    expect(() => assertDeviceGrant(registry, "steffen", "wohnzimmer_tv", "denon", "control")).toThrow(/not available/);
  });

  it("reads the one canonical plugin entry and fails closed", () => {
    expect(registryFromOpenClawConfig({ plugins: { entries: { "device-management": { config }, "google-tv": { config: { devices: [{ id: "wohnzimmer_tv" }] } } } } }).size).toBe(1);
    expect(() => registryFromOpenClawConfig({ plugins: { entries: {} } })).toThrow();
    expect(() => registryFromOpenClawConfig({ plugins: { entries: { "device-management": { enabled: false, config } } } })).toThrow();
    expect(() => registryFromOpenClawConfig({ plugins: { entries: { "device-management": { config } } } })).toThrow(/not enabled/);
    expect(() => registryFromOpenClawConfig({ plugins: { entries: { "device-management": { config }, "google-tv": { config: { devices: [{ id: "different" }] } } } } })).toThrow(/not configured/);
  });

  it("rejects duplicate identities and invalid grants", () => {
    expect(() => parseDeviceRegistry({ devices: [config.devices[0], config.devices[0]] })).toThrow(/duplicate/);
    expect(() => parseDeviceRegistry({ devices: [{ ...config.devices[0], grants: { bodo: ["observe"] }, tools: { status: "google_tv_status" } }] })).toThrow(/corresponding/);
  });

  it("publishes a receiver station catalog only to readers", () => {
    const registry = parseDeviceRegistry({ devices: [{ ...config.devices[0], kind: "media_receiver", provider: "denon", tools: { status: "denon_status", control: "denon_control", stations: "denon_dab_stations" }, grants: { steffen: ["read", "control"], astrid: ["control"] } }] });
    expect(publicDevice(registry.get("wohnzimmer_tv")!, "steffen").tools).toMatchObject({ stations: "denon_dab_stations" });
    expect(publicDevice(registry.get("wohnzimmer_tv")!, "astrid").tools).not.toHaveProperty("stations");
  });
});
