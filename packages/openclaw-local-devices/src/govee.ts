import dgram, { type RemoteInfo, type Socket } from "node:dgram";
import type { DeviceAction, DeviceBackend, DeviceStatus, GoveeDeviceConfig } from "./types.js";
import { LocalDeviceError } from "./types.js";

const GOVEE_RESPONSE_PORT = 4002;
const GOVEE_CONTROL_PORT = 4003;
const MAX_DATAGRAM_BYTES = 8192;
const MAX_QUEUED_STATUS_OPERATIONS = 8;

type GoveeSocketFactory = () => Socket;

function closeSocket(socket: Socket): void {
  try {
    socket.close();
  } catch {
    // A request can be cancelled before the socket binds or sends.
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LocalDeviceError("cancelled", "Govee LAN request was cancelled");
  }
}

function commandPayload(command: string, data: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify({ msg: { cmd: command, data } }), "utf8");
  if (payload.length > 1024) {
    throw new LocalDeviceError("invalid_request", "Govee command exceeds its size limit");
  }
  return payload;
}

export function encodeGoveeAction(action: DeviceAction): Buffer {
  switch (action.type) {
    case "turn_on":
      return commandPayload("turn", { value: 1 });
    case "turn_off":
      return commandPayload("turn", { value: 0 });
    case "set_brightness":
      return commandPayload("brightness", { value: action.brightness });
    case "set_color":
      return commandPayload("colorwc", {
        color: { r: action.red, g: action.green, b: action.blue },
        colorTemInKelvin: 0,
      });
    case "set_color_temperature":
      return commandPayload("colorwc", {
        color: { r: 0, g: 0, b: 0 },
        colorTemInKelvin: action.kelvin,
      });
  }
}

function asNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

export function parseGoveeStatus(
  device: GoveeDeviceConfig,
  packet: Buffer,
): DeviceStatus | undefined {
  if (packet.length > MAX_DATAGRAM_BYTES) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(packet.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return undefined;
  }
  const msg = (decoded as Record<string, unknown>).msg;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return undefined;
  }
  const message = msg as Record<string, unknown>;
  if (
    message.cmd !== "devStatus" ||
    !message.data ||
    typeof message.data !== "object" ||
    Array.isArray(message.data)
  ) {
    return undefined;
  }
  const data = message.data as Record<string, unknown>;
  const onOff = asNumber(data.onOff, 0, 1);
  const brightness = asNumber(data.brightness, 0, 100);
  const temperature = asNumber(data.colorTemInKelvin, 0, 10000);
  const colorValue = data.color;
  let color: DeviceStatus["color"];
  if (colorValue && typeof colorValue === "object" && !Array.isArray(colorValue)) {
    const raw = colorValue as Record<string, unknown>;
    const red = asNumber(raw.r, 0, 255);
    const green = asNumber(raw.g, 0, 255);
    const blue = asNumber(raw.b, 0, 255);
    if (red !== undefined && green !== undefined && blue !== undefined) {
      color = { red, green, blue };
    }
  }
  return {
    id: device.id,
    name: device.name,
    provider: "govee",
    available: true,
    power: onOff === 1 ? "on" : onOff === 0 ? "off" : "unknown",
    ...(brightness === undefined ? {} : { brightness }),
    ...(color ? { color } : {}),
    ...(temperature === undefined || temperature === 0
      ? {}
      : { colorTemperatureKelvin: temperature }),
  };
}

function unavailable(device: GoveeDeviceConfig): DeviceStatus {
  return {
    id: device.id,
    name: device.name,
    provider: "govee",
    available: false,
    power: "unknown",
  };
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  await previous;
  throwIfCancelled(signal);
}

async function queryStatuses(
  devices: readonly GoveeDeviceConfig[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  socketFactory: GoveeSocketFactory,
): Promise<ReadonlyMap<string, DeviceStatus>> {
  throwIfCancelled(signal);
  const byAddress = new Map(devices.map((device) => [device.address, device]));
  const statuses = new Map<string, DeviceStatus>();
  const socket = socketFactory();
  return await new Promise<ReadonlyMap<string, DeviceStatus>>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      closeSocket(socket);
      if (error) {
        reject(error);
        return;
      }
      for (const device of devices) {
        if (!statuses.has(device.id)) {
          statuses.set(device.id, unavailable(device));
        }
      }
      resolve(statuses);
    };
    const onAbort = () =>
      finish(new LocalDeviceError("cancelled", "Govee status request was cancelled"));
    const timer = setTimeout(() => finish(), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.once("error", () =>
      finish(new LocalDeviceError("govee_transport", "Govee LAN status transport failed")),
    );
    socket.on("message", (packet: Buffer, remote: RemoteInfo) => {
      const device = byAddress.get(remote.address);
      if (!device) {
        return;
      }
      const status = parseGoveeStatus(device, packet);
      if (!status) {
        return;
      }
      statuses.set(device.id, status);
      if (statuses.size === devices.length) {
        finish();
      }
    });
    socket.bind(GOVEE_RESPONSE_PORT, "0.0.0.0", () => {
      const payload = commandPayload("devStatus", {});
      for (const device of devices) {
        socket.send(payload, GOVEE_CONTROL_PORT, device.address, (error) => {
          if (error) {
            finish(new LocalDeviceError("govee_transport", "Govee LAN status request failed"));
          }
        });
      }
    });
  });
}

export class GoveeLanStatusCoordinator {
  private tail = Promise.resolve();
  private queuedOperations = 0;

  constructor(private readonly socketFactory: GoveeSocketFactory = () => dgram.createSocket("udp4")) {}

  async query(
    devices: readonly GoveeDeviceConfig[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, DeviceStatus>> {
    if (this.queuedOperations >= MAX_QUEUED_STATUS_OPERATIONS) {
      throw new LocalDeviceError("govee_busy", "Govee LAN status queue is full");
    }
    this.queuedOperations += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForTurn(previous, signal);
      return await queryStatuses(devices, timeoutMs, signal, this.socketFactory);
    } finally {
      this.queuedOperations -= 1;
      release();
    }
  }
}

export class GoveeLanBackend implements DeviceBackend {
  readonly provider = "govee" as const;

  constructor(
    private readonly device: GoveeDeviceConfig,
    private readonly timeoutMs: number,
    private readonly socketFactory: GoveeSocketFactory = () => dgram.createSocket("udp4"),
    private readonly statusCoordinator = new GoveeLanStatusCoordinator(socketFactory),
  ) {}

  get configuredDevice(): GoveeDeviceConfig {
    return this.device;
  }

  get configuredTimeoutMs(): number {
    return this.timeoutMs;
  }

  get coordinator(): GoveeLanStatusCoordinator {
    return this.statusCoordinator;
  }

  async status(signal?: AbortSignal): Promise<DeviceStatus> {
    const statuses = await this.statusCoordinator.query([this.device], this.timeoutMs, signal);
    return statuses.get(this.device.id) ?? unavailable(this.device);
  }

  async control(action: DeviceAction, signal?: AbortSignal): Promise<DeviceStatus> {
    throwIfCancelled(signal);
    const payload = encodeGoveeAction(action);
    const socket = this.socketFactory();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        closeSocket(socket);
        error ? reject(error) : resolve();
      };
      const onAbort = () =>
        finish(new LocalDeviceError("cancelled", "Govee control request was cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      socket.once("error", () =>
        finish(new LocalDeviceError("govee_transport", "Govee LAN control transport failed")),
      );
      socket.send(payload, GOVEE_CONTROL_PORT, this.device.address, (error) => {
        finish(
          error
            ? new LocalDeviceError("govee_transport", "Govee LAN control request failed")
            : undefined,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      };
      const onAbort = () =>
        finish(new LocalDeviceError("cancelled", "Govee control verification was cancelled"));
      const timer = setTimeout(() => finish(), 150);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
    return await this.status(signal);
  }
}

export async function readGoveeStatuses(
  backends: readonly GoveeLanBackend[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, DeviceStatus>> {
  const first = backends[0];
  if (!first) {
    return new Map();
  }
  if (
    backends.some(
      (backend) =>
        backend.coordinator !== first.coordinator ||
        backend.configuredTimeoutMs !== first.configuredTimeoutMs,
    )
  ) {
    throw new LocalDeviceError("invalid_config", "Govee backends do not share one status coordinator");
  }
  return await first.coordinator.query(
    backends.map((backend) => backend.configuredDevice),
    first.configuredTimeoutMs,
    signal,
  );
}
