import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMagicPacket, sendWakePacket, type WakeSocket } from "./wake.js";

const target = { id: "computer_owner", macAddress: "02:ab:cd:00:00:01", broadcastAddress: "192.168.50.255", port: 9 };
class FakeSocket extends EventEmitter implements WakeSocket {
  bind = vi.fn();
  setBroadcast = vi.fn();
  setTTL = vi.fn();
  close = vi.fn();
  send = vi.fn((packet: Uint8Array, _port: number, _address: string, callback: (error: Error | null, bytes: number) => void) => callback(null, packet.byteLength));
}
afterEach(() => vi.useRealTimers());

describe("bounded magic packet transport (fake sockets only)", () => {
  it("constructs exactly the standard 102-byte packet", () => {
    const packet = createMagicPacket(target.macAddress);
    expect(packet).toHaveLength(102);
    expect(packet.subarray(0, 6)).toEqual(Buffer.alloc(6, 255));
    for (let repeat = 0; repeat < 16; repeat++) {
      expect(packet.subarray(6 + repeat * 6, 12 + repeat * 6)).toEqual(Buffer.from("02abcd000001", "hex"));
    }
  });

  it("re-reads the target after bind, sends once, and closes", async () => {
    const socket = new FakeSocket();
    let current = target;
    const result = sendWakePacket(() => current, { timeoutMs: 2000 }, () => socket);
    current = { ...target, broadcastAddress: "10.0.255.255", port: 7 };
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit("listening");
    await result;
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send.mock.calls[0]!.slice(1, 3)).toEqual([current.port, current.broadcastAddress]);
    expect(socket.setBroadcast).toHaveBeenCalledWith(true);
    expect(socket.setTTL).toHaveBeenCalledWith(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("allocates no socket for an already denied or cancelled request", async () => {
    const factory = vi.fn(() => new FakeSocket());
    await expect(sendWakePacket(() => { throw new Error("device_denied"); }, { timeoutMs: 2000 }, factory)).rejects.toThrow("device_denied");
    const abort = new AbortController(); abort.abort();
    await expect(sendWakePacket(() => target, { timeoutMs: 2000, signal: abort.signal }, factory)).rejects.toThrow("cancelled");
    expect(factory).not.toHaveBeenCalled();
  });

  it("bounds concurrent sockets without a queue and releases capacity", async () => {
    const abort = new AbortController();
    const sockets = Array.from({ length: 8 }, () => new FakeSocket());
    const pending = sockets.map((socket) => sendWakePacket(() => target, { timeoutMs: 2000, signal: abort.signal }, () => socket));
    const settled = Promise.allSettled(pending);
    const rejectedFactory = vi.fn(() => new FakeSocket());
    await expect(sendWakePacket(() => target, { timeoutMs: 2000 }, rejectedFactory)).rejects.toThrow("wake_busy");
    expect(rejectedFactory).not.toHaveBeenCalled();
    abort.abort();
    expect((await settled).every((result) => result.status === "rejected")).toBe(true);
    expect(sockets.every((socket) => socket.close.mock.calls.length === 1)).toBe(true);
    const socket = new FakeSocket();
    const result = sendWakePacket(() => target, { timeoutMs: 2000 }, () => socket);
    socket.emit("listening");
    await result;
  });

  it("releases capacity after a socket factory failure", async () => {
    for (let attempt = 0; attempt < 9; attempt++) {
      await expect(sendWakePacket(() => target, { timeoutMs: 2000 }, () => { throw new Error("socket unavailable"); })).rejects.toThrow("socket unavailable");
    }
  });

  it("does not send if authority is revoked while binding", async () => {
    const socket = new FakeSocket();
    let allowed = true;
    const result = sendWakePacket(() => { if (!allowed) throw new Error("device_denied"); return target; }, { timeoutMs: 2000 }, () => socket);
    const rejected = expect(result).rejects.toThrow("device_denied");
    allowed = false;
    socket.emit("listening");
    await rejected;
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("joins cancellation and ignores a late listening callback", async () => {
    const socket = new FakeSocket();
    const abort = new AbortController();
    const result = sendWakePacket(() => target, { timeoutMs: 2000, signal: abort.signal }, () => socket);
    const rejected = expect(result).rejects.toThrow("cancelled");
    abort.abort();
    socket.emit("listening");
    await rejected;
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled bind and removes its timer without retry", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const result = sendWakePacket(() => target, { timeoutMs: 100 }, () => socket);
    const rejected = expect(result).rejects.toThrow("wake_timeout");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports socket errors and short sends, never optimistic success", async () => {
    for (const mode of ["socket", "short", "send"] as const) {
      const socket = new FakeSocket();
      if (mode !== "socket") socket.send.mockImplementation((_packet, _port, _address, callback) => callback(mode === "send" ? new Error("private OS detail") : null, 1));
      const result = sendWakePacket(() => target, { timeoutMs: 2000 }, () => socket);
      const rejected = expect(result).rejects.toThrow("wake_send_failed");
      if (mode === "socket") socket.emit("error", new Error("private OS detail")); else socket.emit("listening");
      await rejected;
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(socket.send.mock.calls.length).toBeLessThanOrEqual(1);
    }
  });
});
