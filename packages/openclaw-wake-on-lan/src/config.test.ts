import { describe, expect, it } from "vitest";
import { parseWakeOnLanConfig, wakeOnLanConfigFromOpenClawConfig } from "./config.js";

const device = { id: "computer_owner", macAddress: "02:AB:CD:00:00:01", broadcastAddress: "192.168.50.255" };

describe("Wake-on-LAN configuration", () => {
  it("normalizes a synthetic unicast MAC and supplies bounded defaults", () => {
    expect(parseWakeOnLanConfig({ devices: [device] })).toEqual({
      devices: [{ ...device, macAddress: "02:ab:cd:00:00:01", port: 9 }], requestTimeoutMs: 2000,
    });
    expect(parseWakeOnLanConfig({ devices: [{ ...device, port: 7 }], requestTimeoutMs: 100 }).devices[0]!.port).toBe(7);
  });

  it.each(["00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01", "02-ab-cd-00-00-01", "<MAC>", "02:ab:cd:00:00:01\n"])("rejects invalid MAC %s", (macAddress) => {
    expect(() => parseWakeOnLanConfig({ devices: [{ ...device, macAddress }] })).toThrow("invalid_config");
  });

  it.each(["8.8.8.8", "224.0.0.1", "0.0.0.0", "127.0.0.1", "::1", "example.org", "192.168.50.999"])("rejects unsupported destination %s", (broadcastAddress) => {
    expect(() => parseWakeOnLanConfig({ devices: [{ ...device, broadcastAddress }] })).toThrow("invalid_config");
  });

  it("accepts explicit private and limited broadcasts without guessing a netmask", () => {
    for (const broadcastAddress of ["10.0.255.255", "172.16.255.255", "172.31.255.255", "255.255.255.255"]) {
      expect(parseWakeOnLanConfig({ devices: [{ ...device, broadcastAddress }] }).devices[0]!.broadcastAddress).toBe(broadcastAddress);
    }
  });

  it("rejects duplicate identities, coercion and copied agent permissions", () => {
    for (const raw of [
      { devices: [] },
      { devices: [{ ...device, id: "computer_owner\n" }] },
      { devices: [device, device] },
      { devices: [device, { ...device, id: "another" }] },
      { devices: [device], requestTimeoutMs: "2000" },
      { devices: [device], requestTimeoutMs: 10001 },
      { devices: [{ ...device, port: "9" }] },
      { devices: [{ ...device, port: 0 }] },
      { devices: [{ ...device, port: 65536 }] },
      { devices: [{ ...device, allowedAgentIds: ["example_owner"] }] },
      { devices: [device], unknown: true },
    ]) expect(() => parseWakeOnLanConfig(raw)).toThrow("invalid_config");
  });

  it("reads only the canonical enabled provider entry", () => {
    const entry = { config: { devices: [device] } };
    expect(wakeOnLanConfigFromOpenClawConfig({ plugins: { entries: { "wake-on-lan": entry } } }).devices).toHaveLength(1);
    expect(() => wakeOnLanConfigFromOpenClawConfig({ plugins: { entries: {} } })).toThrow("invalid_config");
    expect(() => wakeOnLanConfigFromOpenClawConfig({ plugins: { entries: { "wake-on-lan": { ...entry, enabled: false } } } })).toThrow("unavailable");
  });
});
