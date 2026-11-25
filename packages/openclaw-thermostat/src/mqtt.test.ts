import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MqttClient } from "mqtt";
import { ThermostatSession, withThermostat } from "./mqtt.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("mqtt", () => ({ connect }));
const topic = "zigbee2mqtt/0x0011223344556677";

class Client extends EventEmitter {
  connected = true;
  subscribeAsync = vi.fn(async (target: string) => [{ topic: target, qos: 1 }]);
  publishAsync = vi.fn(async (_target: string, _request: string, _options: object) => {});
  end = vi.fn();
  report(target: string, state: object, retain = false) {
    this.emit("message", target, Buffer.from(JSON.stringify(state)), { retain });
  }
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_ZIGBEE_MQTT_USERNAME", "example");
  vi.stubEnv("OPENCLAW_ZIGBEE_MQTT_PASSWORD", "example_password");
});
afterEach(() => {
  vi.unstubAllEnvs();
  connect.mockReset();
});

describe("MQTT thermostat transport", () => {
  it("uses fresh reports from the exact bound topic and ignores unsolicited fields", async () => {
    const client = new Client();
    const authorize = vi.fn();
    client.publishAsync.mockImplementationOnce(async () => {
      client.report(topic, { system_mode: "off" }, true);
      client.report("zigbee2mqtt/other", { system_mode: "auto" });
      client.report(topic, { system_mode: "heat", local_temperature: 22 });
    });
    const session = new ThermostatSession(client as unknown as MqttClient, topic, new AbortController().signal, authorize);
    const result = await session.exchange("get", { system_mode: "" }, ["system_mode"], (state) => typeof state.system_mode === "string");
    expect(result).toEqual({ system_mode: "heat" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(client.publishAsync).toHaveBeenCalledWith(topic + "/get", '{"system_mode":""}', { qos: 1, retain: false });
  });

  it("fails without a write when the grant is revoked just before dispatch", async () => {
    const client = new Client();
    const session = new ThermostatSession(client as unknown as MqttClient, topic, new AbortController().signal, () => { throw new Error("revoked"); });
    await expect(session.send("set", { system_mode: "heat" }, true)).rejects.toThrow();
    expect(client.publishAsync).not.toHaveBeenCalled();
  });

  it("closes the connection and reports an uncertain outcome if a dispatched write cannot be verified", async () => {
    const client = new Client();
    connect.mockReturnValue(client);
    const controller = new AbortController();
    await expect(withThermostat({ port: 1883, baseTopic: "zigbee2mqtt", address: "0x0011223344556677", timeoutMs: 2000 },
      controller.signal, () => {}, async (session) => {
        await session.send("set", { system_mode: "heat" }, true);
        controller.abort();
        return session.exchange("get", { system_mode: "" }, ["system_mode"], (state) => state.system_mode === "heat");
      })).rejects.toMatchObject({ code: "device_write_unconfirmed" });
    expect(client.publishAsync).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledWith(true);
  });
});
