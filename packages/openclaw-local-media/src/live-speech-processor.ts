import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, posix } from "node:path";

const FRAME_BYTES = 640; // 20 ms, mono PCM16 at 16 kHz.
const MAX_PENDING_FRAMES = 100; // Bound latency and child-process input memory to 2 s.
const READY_BYTES = Buffer.from("APM1");

export type LiveSpeechProcessor = {
  connect(): Promise<void>;
  send(audio: Buffer): void;
  close(): void;
};

/** One native APM state per conversational call; never share AGC state across callers. */
export function createLiveSpeechProcessor(params: {
  python: string;
  onFrame: (audio: Buffer) => void;
  onError: (error: Error) => void;
}): LiveSpeechProcessor {
  if (!isAbsolute(params.python) && !posix.isAbsolute(params.python)) {
    throw new Error("Live speech processor requires an absolute Python executable path");
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false;
  let connected = false;
  let incoming = Buffer.alloc(0);
  let outgoing = Buffer.alloc(0);
  let pending = 0;
  let ready = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let startupTimer: NodeJS.Timeout | undefined;

  const reject = (error: Error) => {
    if (closed) return;
    readyReject?.(error);
    readyReject = undefined;
    try {
      params.onError(error);
    } catch {
      // A consumer callback must not prevent release of the native process.
    } finally {
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    connected = false;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    readyReject?.(new Error("Live speech processor closed before ready"));
    readyReject = undefined;
    incoming = Buffer.alloc(0);
    outgoing = Buffer.alloc(0);
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    child?.kill();
  };
  return {
    async connect() {
      if (closed || child) throw new Error("Live speech processor cannot reconnect");
      child = spawn(params.python, ["-m", "openclaw_local_stt.speech_stream"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const readyPromise = new Promise<void>((resolve, rejectPromise) => {
        readyResolve = resolve;
        readyReject = rejectPromise;
      });
      startupTimer = setTimeout(
        () => reject(new Error("Live speech processor startup timed out")),
        10_000,
      );
      child.on("error", (error) => reject(error));
      child.on("exit", () => {
        if (!closed) reject(new Error("Live speech processor exited unexpectedly"));
      });
      child.stdin.on("error", (error) => reject(error));
      child.stdout.on("error", (error) => reject(error));
      child.stdout.on("data", (data: Buffer) => {
        if (closed) return;
        incoming = Buffer.concat([incoming, data]);
        if (!ready) {
          if (incoming.byteLength < READY_BYTES.byteLength) return;
          if (!incoming.subarray(0, READY_BYTES.byteLength).equals(READY_BYTES)) {
            reject(new Error("Live speech processor returned an invalid handshake"));
            return;
          }
          incoming = incoming.subarray(READY_BYTES.byteLength);
          ready = true;
          connected = true;
          if (startupTimer) clearTimeout(startupTimer);
          startupTimer = undefined;
          readyResolve?.();
          readyResolve = undefined;
          readyReject = undefined;
        }
        while (incoming.byteLength >= FRAME_BYTES && !closed) {
          if (pending === 0) {
            reject(new Error("Live speech processor produced an unsolicited audio frame"));
            return;
          }
          const frame = Buffer.from(incoming.subarray(0, FRAME_BYTES));
          incoming = incoming.subarray(FRAME_BYTES);
          pending -= 1;
          try {
            params.onFrame(frame);
          } catch {
            reject(new Error("Live speech processor frame handler failed"));
            return;
          }
        }
        if (incoming.byteLength > FRAME_BYTES) {
          reject(new Error("Live speech processor response framing overflow"));
        }
      });
      // stderr can contain native diagnostics; never forward its contents into logs.
      child.stderr.on("data", () => undefined);
      await readyPromise;
    },
    send(audio) {
      if (!connected || closed || audio.byteLength === 0) return;
      if (audio.byteLength > FRAME_BYTES * (MAX_PENDING_FRAMES + 1) - outgoing.byteLength) {
        reject(new Error("Live speech processor input backlog exceeded"));
        return;
      }
      outgoing = outgoing.byteLength ? Buffer.concat([outgoing, audio]) : Buffer.from(audio);
      while (outgoing.byteLength >= FRAME_BYTES && !closed) {
        if (pending >= MAX_PENDING_FRAMES) {
          reject(new Error("Live speech processor exceeded its latency budget"));
          return;
        }
        const frame = outgoing.subarray(0, FRAME_BYTES);
        outgoing = outgoing.subarray(FRAME_BYTES);
        pending += 1;
        try {
          child?.stdin.write(frame);
        } catch {
          reject(new Error("Live speech processor input pipe failed"));
          return;
        }
      }
    },
    close,
  };
}
