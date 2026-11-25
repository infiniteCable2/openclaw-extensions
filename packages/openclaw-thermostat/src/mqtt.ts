import { connect, type MqttClient } from "mqtt";
import { ThermostatError, type Condition, type Payload } from "./protocol.js";

export type Connection = { port: number; baseTopic: string; timeoutMs: number; address: string };
const active = new Set<string>();
const timeoutError = () => new ThermostatError("device_timeout", "The thermostat did not report the requested values in time.");
const transportError = () => new ThermostatError("device_transport_unavailable", "The local Zigbee MQTT connection is unavailable.");

function abortReason(signal: AbortSignal): ThermostatError {
  return signal.reason?.name === "TimeoutError"
    ? timeoutError()
    : new ThermostatError("device_cancelled", "The thermostat request was cancelled.");
}

function wait<T>(client: MqttClient, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const failed = () => finish(transportError());
    const aborted = () => finish(abortReason(signal));
    const finish = (error?: unknown, result?: T) => {
      client.off("close", failed);
      client.off("error", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(result as T);
    };
    client.once("close", failed);
    client.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason(signal);
      return operation();
    }).then((result) => finish(undefined, result), finish);
  });
}

export class ThermostatSession {
  private dispatched = false;

  constructor(
    private readonly client: MqttClient,
    private readonly topic: string,
    private readonly signal: AbortSignal,
    private readonly authorize: () => void,
  ) {}

  get changingDevice(): boolean { return this.dispatched; }

  async send(suffix: "get" | "set", payload: Payload, changesDevice = false): Promise<void> {
    if (this.signal.aborted) throw abortReason(this.signal);
    await wait(this.client, this.signal, () => {
      this.authorize();
      if (!this.client.connected) throw transportError();
      if (changesDevice) this.dispatched = true;
      return this.client.publishAsync(`${this.topic}/${suffix}`, JSON.stringify(payload), { qos: 1, retain: false })
        .catch(() => { throw transportError(); });
    });
  }

  async exchange(
    suffix: "get" | "set",
    payload: Payload,
    fields: readonly string[],
    ready: Condition,
    options: { partial?: boolean; changesDevice?: boolean; acceptReport?: Condition } = {},
  ): Promise<Payload> {
    const collected: Payload = {};
    let complete: () => void;
    const reported = new Promise<void>((resolve) => { complete = resolve; });
    const onMessage = (topic: string, bytes: Buffer, packet: { retain?: boolean }) => {
      if (topic !== this.topic || packet.retain || bytes.length > 48 * 1024) return;
      let state: unknown;
      try {
        state = JSON.parse(bytes.toString("utf8"));
      } catch {
        return;
      }
      if (typeof state !== "object" || state === null || Array.isArray(state)) return;
      const report = state as Payload;
      if (options.acceptReport && !options.acceptReport(report)) return;
      for (const field of fields) {
        if (Object.hasOwn(report, field) && report[field] !== null) collected[field] = report[field];
      }
      if (ready(collected)) complete();
    };
    this.client.on("message", onMessage);
    const deadline = options.partial ? AbortSignal.any([this.signal, AbortSignal.timeout(4000)]) : this.signal;
    try {
      await this.send(suffix, payload, options.changesDevice);
      await wait(this.client, deadline, () => reported);
    } catch (error) {
      if (!options.partial || !(error instanceof ThermostatError) || error.code !== "device_timeout" ||
          !Object.keys(collected).length) throw error;
    } finally {
      this.client.off("message", onMessage);
    }
    return collected;
  }
}

export async function withThermostat<T>(
  connection: Connection,
  callSignal: AbortSignal | undefined,
  authorize: () => void,
  operation: (session: ThermostatSession) => Promise<T>,
): Promise<T> {
  const topic = `${connection.baseTopic}/${connection.address}`;
  const key = `${connection.port}/${topic}`;
  if (active.has(key) || active.size >= 4) {
    throw new ThermostatError("device_busy", "A thermostat operation is already in progress. Try again shortly.");
  }
  const deadline = AbortSignal.timeout(connection.timeoutMs);
  const signal = callSignal ? AbortSignal.any([deadline, callSignal]) : deadline;
  if (signal.aborted) throw abortReason(signal);
  const username = process.env.OPENCLAW_ZIGBEE_MQTT_USERNAME;
  const password = process.env.OPENCLAW_ZIGBEE_MQTT_PASSWORD;
  if (!username || !password) {
    throw new ThermostatError("device_configuration_invalid", "Credentials for the local Zigbee MQTT connection are missing.");
  }
  authorize();
  active.add(key);
  let client: MqttClient | undefined;
  let session: ThermostatSession | undefined;
  try {
    const connectionClient = connect(`mqtt://127.0.0.1:${connection.port}`, {
      username,
      password,
      protocolVersion: 4,
      reconnectPeriod: 0,
      connectTimeout: connection.timeoutMs,
      clean: true,
      queueQoSZero: false,
    });
    client = connectionClient;
    // MQTT.js can report more than one error while draining a failed connection.
    connectionClient.on("error", () => {});
    await wait(connectionClient, signal, () => new Promise<void>((resolve) => {
      if (connectionClient.connected) resolve();
      else connectionClient.once("connect", () => resolve());
    }));
    const granted = await wait(connectionClient, signal, () => connectionClient.subscribeAsync(topic, { qos: 1 }));
    if (granted.length !== 1 || granted[0]?.qos === 128) throw transportError();
    session = new ThermostatSession(connectionClient, topic, signal, authorize);
    return await operation(session);
  } catch (error) {
    if (session?.changingDevice && !(error instanceof ThermostatError && error.code === "device_calibration_failed")) {
      throw new ThermostatError("device_write_unconfirmed", "The command may have been applied. Read the current state before retrying.");
    }
    throw error;
  } finally {
    client?.end(true);
    active.delete(key);
  }
}
