import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, posix } from "node:path";

const FRAME_BYTES = 640; // 20 ms, mono PCM16 at 16 kHz.
const METADATA_BYTES = 56; // APM3: probability, gain, then bounded numeric control observations.
const RESPONSE_BYTES = FRAME_BYTES + METADATA_BYTES;
const MAX_PENDING_FRAMES = 100; // Bound latency and child-process input memory to 2 s.
const RESPONSE_TIMEOUT_MS = 2_000;
const READY_BYTES = Buffer.from("APM3");

export type LiveSpeechControl = {
  cleanRms: number;
  nativeGainDb: number;
  minimumCeilingDb: number;
  maximumCeilingDb: number;
  speechFrames: number;
  uncertainFrames: number;
  nonspeechFrames: number;
  holdFrames: number;
  attenuateFrames: number;
  recoverFrames: number;
  clippedFrames: number;
  mutedFrames: number;
};

function readControl(data: Buffer): LiveSpeechControl | undefined {
  const read = (index: number) => data.readFloatLE(FRAME_BYTES + 8 + index * 4);
  const control: LiveSpeechControl = {
    cleanRms: read(0),
    nativeGainDb: read(1),
    minimumCeilingDb: read(2),
    maximumCeilingDb: read(3),
    speechFrames: read(4),
    uncertainFrames: read(5),
    nonspeechFrames: read(6),
    holdFrames: read(7),
    attenuateFrames: read(8),
    recoverFrames: read(9),
    clippedFrames: read(10),
    mutedFrames: read(11),
  };
  if (Object.values(control).some((value) => !Number.isFinite(value))) return;
  const counts = [
    control.speechFrames,
    control.uncertainFrames,
    control.nonspeechFrames,
    control.holdFrames,
    control.attenuateFrames,
    control.recoverFrames,
    control.clippedFrames,
    control.mutedFrames,
  ];
  if (
    control.cleanRms < 0 ||
    control.cleanRms > 64 ||
    Math.abs(control.nativeGainDb) > 120 ||
    control.minimumCeilingDb < -60 ||
    control.maximumCeilingDb > 60 ||
    control.minimumCeilingDb > control.maximumCeilingDb ||
    counts.some((value) => !Number.isInteger(value) || value < 0 || value > 2) ||
    control.speechFrames + control.uncertainFrames + control.nonspeechFrames !== 2 ||
    control.holdFrames + control.attenuateFrames + control.recoverFrames !== 2 ||
    control.clippedFrames + control.mutedFrames > 2
  )
    return;
  return control;
}

export type LiveSpeechFrame = {
  audio: Buffer;
  speechProbability: number;
  gainDb: number;
  originalRms: number;
  originalPeak: number;
  control?: LiveSpeechControl;
};

export type LiveSpeechProcessor = {
  connect(): Promise<void>;
  send(audio: Buffer): void;
  discardPartialInput(): void;
  close(): void;
};

/** One native APM state per conversational call; never share AGC state across callers. */
export function createLiveSpeechProcessor(params: {
  python: string;
  onFrame: (frame: LiveSpeechFrame) => void;
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
  const originalFrames: Array<{ originalRms: number; originalPeak: number; sentAt: number }> = [];
  let responseTimer: NodeJS.Timeout | undefined;
  let partialTimer: NodeJS.Timeout | undefined;
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
    originalFrames.length = 0;
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = undefined;
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = undefined;
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr.destroy();
    child?.kill();
  };
  const armResponseDeadline = () => {
    if (responseTimer) clearTimeout(responseTimer);
    responseTimer = undefined;
    const oldest = originalFrames[0];
    if (!oldest || closed) return;
    responseTimer = setTimeout(
      () => reject(new Error("Live speech processor response timed out")),
      Math.max(1, RESPONSE_TIMEOUT_MS - (performance.now() - oldest.sentAt)),
    );
    responseTimer.unref?.();
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
        while (incoming.byteLength >= RESPONSE_BYTES && !closed) {
          if (pending === 0) {
            reject(new Error("Live speech processor produced an unsolicited audio frame"));
            return;
          }
          const audio = Buffer.from(incoming.subarray(0, FRAME_BYTES));
          const speechProbability = incoming.readFloatLE(FRAME_BYTES);
          const gainDb = incoming.readFloatLE(FRAME_BYTES + 4);
          const control = readControl(incoming);
          incoming = incoming.subarray(RESPONSE_BYTES);
          pending -= 1;
          const original = originalFrames.shift();
          armResponseDeadline();
          if (!original) {
            reject(new Error("Live speech processor lost input frame alignment"));
            return;
          }
          if (
            !Number.isFinite(speechProbability) ||
            speechProbability < 0 ||
            speechProbability > 1 ||
            !Number.isFinite(gainDb) ||
            gainDb < -60 ||
            gainDb > 60 ||
            !control
          ) {
            reject(new Error("Live speech processor returned invalid frame metadata"));
            return;
          }
          try {
            params.onFrame({
              audio,
              speechProbability,
              gainDb,
              originalRms: original.originalRms,
              originalPeak: original.originalPeak,
              control,
            });
          } catch {
            reject(new Error("Live speech processor frame handler failed"));
            return;
          }
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
        let squares = 0;
        let peak = 0;
        for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
          const sample = frame.readInt16LE(offset) / 32_768;
          squares += sample * sample;
          peak = Math.max(peak, Math.abs(sample));
        }
        originalFrames.push({
          originalRms: Math.sqrt(squares / (FRAME_BYTES / 2)),
          originalPeak: peak,
          sentAt: performance.now(),
        });
        if (pending === 1) armResponseDeadline();
        try {
          child?.stdin.write(frame);
        } catch {
          reject(new Error("Live speech processor input pipe failed"));
          return;
        }
      }
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = undefined;
      if (!closed && outgoing.byteLength > 0) {
        partialTimer = setTimeout(() => {
          partialTimer = undefined;
          outgoing = Buffer.alloc(0);
        }, RESPONSE_TIMEOUT_MS);
        partialTimer.unref?.();
      }
    },
    discardPartialInput() {
      outgoing = Buffer.alloc(0);
      if (partialTimer) clearTimeout(partialTimer);
      partialTimer = undefined;
    },
    close,
  };
}
