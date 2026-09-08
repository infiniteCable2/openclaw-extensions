import { describe, expect, it } from "vitest";
import { isPrivateIpv4, parseFritzBaseUrl, parseLocalDevicesConfig } from "./config.js";

describe("local device config", () => {
  it("accepts bounded private devices and explicit agents", () => {
    const config = parseLocalDevicesConfig({
      allowedAgentIds: ["steffen", "astrid"],
      requestTimeoutMs: 3000,
      govee: { devices: [{ id: "living_light", address: "192.168.1.25" }] },
    });

    expect([...config.allowedAgentIds]).toEqual(["steffen", "astrid"]);
    expect(config.govee?.devices[0]?.name).toBe("living_light");
  });

  it("rejects public Govee targets and duplicate provider ids", () => {
    expect(() =>
      parseLocalDevicesConfig({
        allowedAgentIds: ["steffen"],
        govee: { devices: [{ id: "lamp", address: "8.8.8.8" }] },
      }),
    ).toThrow(/private IPv4/);

    expect(() =>
      parseLocalDevicesConfig({
        allowedAgentIds: ["steffen"],
        govee: { devices: [{ id: "lamp", address: "192.168.1.25" }] },
        fritz: {
          username: "operator",
          password: "secret",
          devices: [{ id: "lamp", uid: "unit45f9-a95b-45dd-ae7a-30af27185303" }],
        },
      }),
    ).toThrow(/unique/);

    expect(() =>
      parseLocalDevicesConfig({
        allowedAgentIds: ["steffen"],
        govee: {
          devices: [
            { id: "lamp_a", address: "192.168.1.25" },
            { id: "lamp_b", address: "192.168.1.25" },
          ],
        },
      }),
    ).toThrow(/addresses must be unique/);
  });

  it("accepts only a private FRITZ!Box origin", () => {
    expect(parseFritzBaseUrl("http://fritz.box")).toBe("http://fritz.box");
    expect(parseFritzBaseUrl("https://192.168.1.1:49443")).toBe("https://192.168.1.1:49443");
    expect(() => parseFritzBaseUrl("https://example.com")).toThrow(/private FRITZ/);
    expect(() => parseFritzBaseUrl("http://user:pass@fritz.box")).toThrow(/without credentials/);
  });

  it("recognizes only private IPv4 ranges", () => {
    expect(isPrivateIpv4("10.1.2.3")).toBe(true);
    expect(isPrivateIpv4("172.31.1.2")).toBe(true);
    expect(isPrivateIpv4("192.168.1.2")).toBe(true);
    expect(isPrivateIpv4("172.32.1.2")).toBe(false);
    expect(isPrivateIpv4("1.1.1.1")).toBe(false);
  });

  it("rejects unknown fields and more than 16 devices in total", () => {
    expect(() =>
      parseLocalDevicesConfig({
        allowedAgentIds: ["steffen"],
        govee: { devices: [{ id: "lamp", address: "192.168.1.25", cloudToken: "no" }] },
      }),
    ).toThrow(/cloudToken is not supported/);

    expect(() =>
      parseLocalDevicesConfig({
        allowedAgentIds: ["steffen"],
        govee: {
          devices: Array.from({ length: 9 }, (_, index) => ({
            id: `light_${index}`,
            address: `192.168.1.${index + 20}`,
          })),
        },
        fritz: {
          username: "operator",
          password: "secret",
          devices: Array.from({ length: 8 }, (_, index) => ({
            id: `socket_${index}`,
            uid: `unit-${index}`,
          })),
        },
      }),
    ).toThrow(/at most 16 devices/);
  });
});
