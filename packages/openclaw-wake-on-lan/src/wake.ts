import { createSocket } from "node:dgram";
import { normalizeMacAddress, type WakeOnLanDevice } from "./config.js";
import { WakeOnLanError } from "./errors.js";

const maxConcurrentSends = 8;
let activeSends = 0;

/** The operation uses only this small part of Node's UDP socket contract. */
export type WakeSocket = {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "listening", listener: () => void): unknown;
  bind(): unknown;
  setBroadcast(enabled: boolean): unknown;
  setTTL(ttl: number): unknown;
  send(packet: Uint8Array, port: number, address: string, callback: (error: Error | null, bytes: number) => void): unknown;
  close(): unknown;
};

export function createMagicPacket(macAddress: string): Buffer {
  const mac = Buffer.from(normalizeMacAddress(macAddress).replaceAll(":", ""), "hex");
  const packet = Buffer.alloc(102, 0xff);
  for (let repeat = 0; repeat < 16; repeat++) mac.copy(packet, 6 + repeat * 6);
  return packet;
}

/** One datagram, no retry, acknowledgement, power toggle, discovery or shell. */
export async function sendWakePacket(
  resolveTarget: () => WakeOnLanDevice,
  options: { timeoutMs: number; signal?: AbortSignal },
  socketFactory: () => WakeSocket = () => createSocket("udp4"),
): Promise<void> {
  if (options.signal?.aborted) throw new WakeOnLanError("cancelled");
  resolveTarget(); // Reject unauthorized callers before allocating any socket.
  if (activeSends >= maxConcurrentSends) throw new WakeOnLanError("wake_busy");
  activeSends++;
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = socketFactory();
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        try { socket.close(); } catch { /* A failed bind may leave the socket unbound. */ }
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(new WakeOnLanError("cancelled"));
      const timer = setTimeout(() => finish(new WakeOnLanError("wake_timeout")), options.timeoutMs);
      socket.once("error", () => finish(new WakeOnLanError("wake_send_failed")));
      socket.once("listening", () => {
        if (settled) return;
        try {
          // Bind is asynchronous: re-read grants AND the endpoint immediately before send.
          const target = resolveTarget();
          const packet = createMagicPacket(target.macAddress);
          socket.setBroadcast(true);
          socket.setTTL(1);
          socket.send(packet, target.port, target.broadcastAddress, (error, bytes) => {
            finish(error || bytes !== packet.length ? new WakeOnLanError("wake_send_failed") : undefined);
          });
        } catch (error) { finish(error); }
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      try { socket.bind(); } catch { finish(new WakeOnLanError("wake_send_failed")); }
    });
  } finally { activeSends--; }
}
