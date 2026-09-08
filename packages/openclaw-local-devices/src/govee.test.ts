import { EventEmitter } from "node:events";
import type { Socket } from "node:dgram";
import { describe, expect, it, vi } from "vitest";
import {
  encodeGoveeAction,
  GoveeLanBackend,
  GoveeLanStatusCoordinator,
  parseGoveeStatus,
  readGoveeStatuses,
} from "./govee.js";

const device = { id: "living_light", name: "Living light", address: "192.168.1.25" };

describe("Govee LAN protocol", () => {
  it("encodes only the fixed LAN command shapes", () => {
    expect(JSON.parse(encodeGoveeAction({ type: "turn_on" }).toString())).toEqual({
      msg: { cmd: "turn", data: { value: 1 } },
    });
    expect(
      JSON.parse(
        encodeGoveeAction({ type: "set_color", red: 10, green: 20, blue: 30 }).toString(),
      ),
    ).toEqual({
      msg: {
        cmd: "colorwc",
        data: { color: { r: 10, g: 20, b: 30 }, colorTemInKelvin: 0 },
      },
    });
  });

  it("projects a bounded status without transport identifiers", () => {
    const result = parseGoveeStatus(
      device,
      Buffer.from(
        JSON.stringify({
          msg: {
            cmd: "devStatus",
            data: {
              onOff: 1,
              brightness: 45,
              color: { r: 1, g: 2, b: 3 },
              colorTemInKelvin: 4200,
            },
          },
        }),
      ),
    );

    expect(result).toEqual({
      id: "living_light",
      name: "Living light",
      provider: "govee",
      available: true,
      power: "on",
      brightness: 45,
      color: { red: 1, green: 2, blue: 3 },
      colorTemperatureKelvin: 4200,
    });
    expect(JSON.stringify(result)).not.toContain("192.168.1.25");
  });

  it("ignores malformed or unrelated datagrams", () => {
    expect(parseGoveeStatus(device, Buffer.from("not-json"))).toBeUndefined();
    expect(
      parseGoveeStatus(device, Buffer.from(JSON.stringify({ msg: { cmd: "scan", data: {} } }))),
    ).toBeUndefined();
  });

  it("reads multiple configured devices through one shared response socket", async () => {
    const emitter = new EventEmitter();
    const bind = vi.fn((_port: number, _address: string, callback: () => void) => callback());
    const send = vi.fn(
      (_packet: Buffer, _port: number, address: string, callback: (error?: Error) => void) => {
        callback();
        queueMicrotask(() => {
          emitter.emit(
            "message",
            Buffer.from(
              JSON.stringify({ msg: { cmd: "devStatus", data: { onOff: 1, brightness: 50 } } }),
            ),
            { address },
          );
        });
      },
    );
    const socket = Object.assign(emitter, { bind, send, close: vi.fn() }) as unknown as Socket;
    const coordinator = new GoveeLanStatusCoordinator(() => socket);
    const second = { id: "desk_light", name: "Desk light", address: "192.168.1.26" };
    const backends = [
      new GoveeLanBackend(device, 100, () => socket, coordinator),
      new GoveeLanBackend(second, 100, () => socket, coordinator),
    ];

    const statuses = await readGoveeStatuses(backends);

    expect(bind).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(statuses.get("living_light")?.available).toBe(true);
    expect(statuses.get("desk_light")?.available).toBe(true);
  });
});
