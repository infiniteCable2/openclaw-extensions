import { describe, expect, it } from "vitest";
import { parseTvConfig } from "./config.js";

const valid = {
  allowedAgentIds: ["steffen", "astrid"],
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
    expect([...config.allowedAgentIds]).toEqual(["steffen", "astrid"]);
    expect(config.allowedAgentIds.has("bodo")).toBe(false);
    expect(config.devices.get("wohnzimmer_tv")?.apps[0]?.via).toBe("adb");
    expect(config.devices.get("wohnzimmer_tv")?.adb?.serverPort).toBe(5038);
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
