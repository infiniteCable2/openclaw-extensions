import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const speech = (ms: number) => Buffer.alloc(ms * 8, 0x80);
const silence = (ms: number) => Buffer.alloc(ms * 8, 0xff);
const response = (text: string) =>
  new Response(
    (text ? 'data: {"type":"speech.confirmed"}\n\n' : "") +
      `data: ${JSON.stringify({ type: "transcript.done", text, model: "test" })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

function fixture(
  options: {
    mode?: "client" | "server";
    texts?: string[];
    config?: Record<string, unknown>;
  } = { mode: "client" },
) {
  vi.useFakeTimers();
  const onTranscript = vi.fn();
  const onPartial = vi.fn();
  const onProcessing = vi.fn();
  const onSpeechStart = vi.fn();
  const onError = vi.fn();
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ release }));
  let index = 0;
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    response(options.texts?.[index++] ?? "Synthetic request"),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = buildLocalRealtimeTranscriptionProvider(acquire);
  const session = provider.createSession({
    providerConfig: {
      baseUrl: "http://127.0.0.1:8010/v1",
      speechOnsetMs: 40,
      minSpeechMs: 40,
      silenceMs: 200,
      preRollMs: 40,
      maxUtteranceMs: 1_000,
      ...options.config,
    },
    ...(options.mode === undefined ? {} : { inputEndMode: options.mode }),
    onTranscript,
    onPartial,
    onProcessing,
    onSpeechStart,
    onError,
  });
  return {
    provider,
    session,
    fetch,
    acquire,
    release,
    onTranscript,
    onPartial,
    onProcessing,
    onSpeechStart,
    onError,
  };
}

describe("exclusive client transcription input completion", () => {
  it.each([undefined, "server"] as const)(
    "preserves acoustic completion for %s mode",
    async (mode) => {
      const f = fixture({ mode });
      await f.session.connect();
      try {
        f.session.sendAudio(Buffer.concat([speech(200), silence(200)]));
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onTranscript).toHaveBeenCalledExactlyOnceWith("Synthetic request", {
          utteranceId: "utterance-1",
        });
        expect(f.onProcessing.mock.calls.map(([event]) => event.state)).toEqual([
          "started",
          "speech-confirmed",
          "transcribed",
        ]);
      } finally {
        f.session.close();
      }
    },
  );

  it("keeps pauses and resumed speech in one bounded turn until the explicit boundary", async () => {
    const f = fixture({ mode: "client", texts: ["First part", "last part"] });
    await f.session.connect();
    try {
      expect(f.provider.supportsClientInputEnd).toBe(true);
      f.session.sendAudio(Buffer.concat([speech(400), silence(200)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).not.toHaveBeenCalled();
      f.session.sendAudio(Buffer.concat([speech(200), silence(200)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onPartial).toHaveBeenCalledExactlyOnceWith("First part");
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onProcessing).not.toHaveBeenCalled();
      expect(f.onSpeechStart).toHaveBeenCalledOnce();
      const boundary = f.session.finishInput?.({ captureId: "capture-first" });
      await expect(boundary).resolves.toEqual({ activity: "observed" });
      expect(f.onProcessing.mock.calls.map(([event]) => event.state)).toEqual([
        "started",
        "speech-confirmed",
      ]);
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.session.finishInput?.({ captureId: "capture-first" })).toBe(boundary);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript).toHaveBeenCalledExactlyOnceWith("First part last part", {
        utteranceId: "utterance-1",
      });
      expect(f.onProcessing.mock.calls.map(([event]) => event.state)).toEqual([
        "started",
        "speech-confirmed",
        "transcribed",
      ]);
      const durations = await Promise.all(
        f.fetch.mock.calls.map(async ([, init]) => {
          const wav = await ((init?.body as FormData).get("file") as File).arrayBuffer();
          return (wav.byteLength - 44) / 16;
        }),
      );
      expect(durations.reduce((sum, duration) => sum + duration, 0)).toBe(1_000);
      expect(durations.every((duration) => duration <= 1_000)).toBe(true);
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.session.close();
    }
  });

  it.each([0, 400])("retains earlier text with a %sms quiet final tail", async (quietMs) => {
    const f = fixture({ mode: "client", texts: ["Complete words", ""] });
    await f.session.connect();
    try {
      f.session.sendAudio(speech(1_000));
      await vi.advanceTimersByTimeAsync(0);
      f.session.sendAudio(silence(quietMs));
      expect(f.onTranscript).not.toHaveBeenCalled();
      await f.session.finishInput?.({ captureId: "capture-tail" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledTimes(quietMs === 0 ? 1 : 2);
      expect(f.onTranscript).toHaveBeenCalledExactlyOnceWith("Complete words", {
        utteranceId: "utterance-1",
      });
    } finally {
      f.session.close();
    }
  });

  it("keeps overlapping acknowledged captures separate while the first decoder is held", async () => {
    const f = fixture({ mode: "client", texts: ["Second request"] });
    let resolve!: (value: Response) => void;
    const held = new Promise<Response>((done) => {
      resolve = done;
    });
    f.fetch.mockImplementationOnce(() => held);
    await f.session.connect();
    try {
      f.session.sendAudio(speech(1_000));
      await vi.advanceTimersByTimeAsync(0);
      const boundary = f.session.finishInput?.({ captureId: "capture-held" });
      await expect(boundary).resolves.toEqual({ activity: "observed" });
      expect(f.onProcessing.mock.calls.map(([event]) => event)).toEqual([
        { utteranceId: "utterance-1", state: "started" },
      ]);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onTranscript).not.toHaveBeenCalled();
      f.session.sendAudio(speech(200));
      expect(f.session.finishInput?.({ captureId: "capture-held" })).toBe(boundary);
      const next = f.session.finishInput?.({ captureId: "capture-next" });
      expect(next).not.toBe(boundary);
      await expect(next).resolves.toEqual({ activity: "observed" });
      expect(f.onProcessing.mock.calls.map(([event]) => event)).toEqual([
        { utteranceId: "utterance-1", state: "started" },
        { utteranceId: "utterance-2", state: "started" },
      ]);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onTranscript).not.toHaveBeenCalled();
      resolve(response("First request"));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript.mock.calls).toEqual([
        ["First request", { utteranceId: "utterance-1" }],
        ["Second request", { utteranceId: "utterance-2" }],
      ]);
      expect(f.onProcessing.mock.calls.map(([event]) => event)).toEqual([
        { utteranceId: "utterance-1", state: "started" },
        { utteranceId: "utterance-2", state: "started" },
        { utteranceId: "utterance-1", state: "transcribed" },
        { utteranceId: "utterance-2", state: "speech-confirmed" },
        { utteranceId: "utterance-2", state: "transcribed" },
      ]);
      expect(f.session.finishInput?.({ captureId: "capture-next" })).toBe(next);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.release).toHaveBeenCalledTimes(2);
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.session.close();
    }
  });

  it.each(["empty", "short", "gap", "close"] as const)(
    "never finalizes %s input as a command",
    async (kind) => {
      const f = fixture({ mode: "client", config: { minSpeechMs: 200 } });
      await f.session.connect();
      try {
        if (kind === "empty") f.session.sendAudio(silence(400));
        else f.session.sendAudio(speech(kind === "short" ? 80 : 1_000));
        if (kind === "gap") await vi.advanceTimersByTimeAsync(2_000);
        if (kind === "close") f.session.close();
        else await f.session.finishInput?.({ captureId: "capture-rejected" });
        await vi.advanceTimersByTimeAsync(0);
        expect(f.onTranscript).not.toHaveBeenCalled();
        expect(f.onProcessing).not.toHaveBeenCalled();
        expect(f.onError).not.toHaveBeenCalled();
      } finally {
        f.session.close();
      }
    },
  );

  it("fails closed on the existing queue bound instead of dispatching an earlier batch", async () => {
    const f = fixture();
    await f.session.connect();
    try {
      f.session.sendAudio(speech(3_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onPartial).not.toHaveBeenCalled();
      expect(f.onError).toHaveBeenCalledOnce();
      expect(f.session.isConnected()).toBe(false);
    } finally {
      f.session.close();
    }
  });

  it("settles empty recognition only after the client seals real speech input", async () => {
    const f = fixture({ mode: "client", texts: [""] });
    await f.session.connect();
    try {
      f.session.sendAudio(Buffer.concat([speech(200), silence(200)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onProcessing).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
      await f.session.finishInput?.({ captureId: "capture-empty-recognition" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onProcessing.mock.calls.map(([event]) => event.state)).toEqual(["started", "empty"]);
    } finally {
      f.session.close();
    }
  });

  it("discards an in-flight batch result after capture cancellation", async () => {
    const f = fixture();
    let resolve!: (value: Response) => void;
    const held = new Promise<Response>((done) => {
      resolve = done;
    });
    f.fetch.mockImplementationOnce(() => held);
    await f.session.connect();
    try {
      f.session.sendAudio(speech(1_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledOnce();
      f.session.close();
      resolve(response("Discarded words"));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onPartial).not.toHaveBeenCalled();
      expect(f.onProcessing).not.toHaveBeenCalled();
      expect(f.onError).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      f.session.close();
    }
  });

  it("rejects accumulated text overflow without dispatching a truncated capture", async () => {
    const f = fixture({ mode: "client", texts: ["é".repeat(80_000), "é".repeat(80_000)] });
    await f.session.connect();
    try {
      f.session.sendAudio(speech(1_000));
      await vi.advanceTimersByTimeAsync(0);
      f.session.sendAudio(speech(200));
      await f.session.finishInput?.({ captureId: "capture-large" });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onError).toHaveBeenCalledOnce();
      expect(f.onProcessing.mock.calls.at(-1)?.[0].state).toBe("failed");
    } finally {
      f.session.close();
    }
  });
});
