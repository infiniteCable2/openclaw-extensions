import { describe, expect, it } from "vitest";
import { parseTvConfig } from "./config.js";

const valid = {
  allowedAgentIds: ["example_owner", "example_member"],
  pythonPath: "/opt/tv/bin/python",
  devices: [{
    id: "wohnzimmer_tv", name: "Wohnzimmer", host: "192.168.1.106",
    remoteCertPath: "/etc/tv/client.crt", remoteKeyPath: "/etc/tv/client.key",
    adb: { path: "/opt/adb", home: "/var/lib/adb", serial: "paired-tv" },
    apps: [{ id: "ard", name: "ARD", via: "adb", locator: "de.swr.avp.ard.tv" }],
  }],
};

describe("TV configuration", () => {
  it("allows only listed agents and explicit app/transport bindings", () => {
    const config = parseTvConfig(valid);
    expect([...config.allowedAgentIds]).toEqual(["example_owner", "example_member"]);
    expect(config.allowedAgentIds.has("example_other")).toBe(false);
    expect(config.devices.get("wohnzimmer_tv")?.apps[0]?.via).toBe("adb");
    expect(config.devices.get("wohnzimmer_tv")?.adb?.serverPort).toBe(5038);
    expect(config.powerOnTimeoutMs).toBe(30000);
    expect(config.screenshotMaxAgeSeconds).toBe(900);
    expect(config.screenshotDirectory).toContain("media");
  });
  it("accepts an explicit bounded Wake-on-WLAN target and screenshot directory", () => {
    const config = parseTvConfig({ ...valid, screenshotDirectory: "/var/lib/openclaw/media/google-tv", devices: [{ ...valid.devices[0], wake: { macAddress: "02:11:22:33:44:55", broadcastAddress: "192.168.1.255" } }] });
    expect(config.devices.get("wohnzimmer_tv")?.wake?.macAddress).toBe("02:11:22:33:44:55");
    expect(config.screenshotDirectory).toBe("/var/lib/openclaw/media/google-tv");
  });
  it("rejects a multicast Wake-on-WLAN address", () => {
    expect(() => parseTvConfig({ ...valid, devices: [{ ...valid.devices[0], wake: { macAddress: "01:11:22:33:44:55", broadcastAddress: "192.168.1.255" } }] })).toThrow("unicast MAC");
  });
  it("rejects public target addresses", () => {
    expect(() => parseTvConfig({ ...valid, devices: [{ ...valid.devices[0], host: "8.8.8.8" }] })).toThrow("private IPv4");
  });
  it("rejects ADB app without configured ADB", () => {
    const { adb: _adb, ...device } = valid.devices[0];
    expect(() => parseTvConfig({ ...valid, devices: [device] })).toThrow("requires configured ADB");
  });
  it("rejects duplicate device ids", () => {
    expect(() => parseTvConfig({ ...valid, devices: [valid.devices[0], valid.devices[0]] })).toThrow("duplicate device id");
  });
});
