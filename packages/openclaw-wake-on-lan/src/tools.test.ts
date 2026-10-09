import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseDeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";
import { parseWakeOnLanConfig } from "./config.js";
import { WakeOnLanError } from "./errors.js";
import { createWakeOnLanTools, stateFromOpenClawConfig } from "./tools.js";
import type { sendWakePacket } from "./wake.js";

const registryConfig = {
  providers: { "wake-on-lan": fileURLToPath(new URL("../", import.meta.url)) },
  devices: [{ id: "computer_owner", name: "Example computer", kind: "computer", siteId: "home_site", room: "Test room", provider: "wake-on-lan", grants: { example_owner: ["read", "control"] } }],
};
const providerConfig = { devices: [{ id: "computer_owner", macAddress: "02:ab:cd:00:00:01", broadcastAddress: "192.168.50.255" }] };
const state = () => ({ registry: parseDeviceRegistry(registryConfig), config: parseWakeOnLanConfig(providerConfig) });

describe("Wake-on-LAN agent-scoped tools", () => {
  it("sends only for the owner and never claims a confirmed power state", async () => {
    const sender = vi.fn<typeof sendWakePacket>(async (resolveTarget) => { resolveTarget(); });
    const tool = createWakeOnLanTools("example_owner", state, sender)[1]!;
    expect((await tool.execute("call", { device: "computer_owner" })).details).toEqual({ ok: true, device: { id: "computer_owner", wakeSent: true, confirmed: false, online: "unknown" } });
    expect(sender).toHaveBeenCalledTimes(1);
    for (const agent of ["example_member", "example_other", "ops"]) {
      expect((await createWakeOnLanTools(agent, state, sender)[1]!.execute("call", { device: "computer_owner" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    }
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("rejects raw destinations and malformed requests before calling the sender", async () => {
    const sender = vi.fn<typeof sendWakePacket>(async () => {});
    const tool = createWakeOnLanTools("example_owner", state, sender)[1]!;
    for (const input of [null, [], {}, { device: 1 }, { device: "computer_owner\n" }, { device: "computer_owner", macAddress: "02:ab:cd:00:00:02" }, { device: "computer_owner", port: 7 }]) {
      expect((await tool.execute("call", input)).details).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not contact devices for status or disclose other agents' devices", async () => {
    const sender = vi.fn<typeof sendWakePacket>(async () => {});
    expect((await createWakeOnLanTools("example_owner", state, sender)[0]!.execute("call", {})).details).toEqual({ ok: true, devices: [{ id: "computer_owner", readyToSend: true, online: "unknown" }] });
    expect((await createWakeOnLanTools("example_other", state, sender)[0]!.execute("call", {})).details).toEqual({ ok: true, devices: [] });
    expect(sender).not.toHaveBeenCalled();
  });

  it("re-reads canonical provider disablement and registry revocation", async () => {
    let current: unknown = { plugins: { entries: { "device-management": { config: registryConfig }, "wake-on-lan": { config: providerConfig } } } };
    const sender = vi.fn<typeof sendWakePacket>(async (resolveTarget) => { resolveTarget(); });
    const tool = createWakeOnLanTools("example_owner", () => stateFromOpenClawConfig(current), sender)[1]!;
    current = { plugins: { entries: { "device-management": { config: registryConfig }, "wake-on-lan": { enabled: false, config: providerConfig } } } };
    expect((await tool.execute("call", { device: "computer_owner" })).details).toMatchObject({ ok: false });
    current = { plugins: { entries: { "device-management": { config: { ...registryConfig, devices: [{ ...registryConfig.devices[0], grants: { example_other: ["read"] } }] } }, "wake-on-lan": { config: providerConfig } } } };
    expect((await tool.execute("call", { device: "computer_owner" })).details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    expect(sender).not.toHaveBeenCalled();
  });

  it("returns bounded failure codes without retry or underlying details", async () => {
    const sender = vi.fn<typeof sendWakePacket>(async () => { throw new WakeOnLanError("wake_timeout"); });
    expect((await createWakeOnLanTools("example_owner", state, sender)[1]!.execute("call", { device: "computer_owner" })).details).toEqual({ ok: false, error: { code: "wake_timeout" } });
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
