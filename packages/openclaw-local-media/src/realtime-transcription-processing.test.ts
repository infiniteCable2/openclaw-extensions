import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const voiced = (frames = 2) => Buffer.alloc(frames * 160, 0x80);
const quiet = () => Buffer.alloc(10 * 160, 0xff);
const utterance = () => Buffer.concat([voiced(), quiet()]);
const encode = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const confirmation = encode({ type: "speech.confirmed" });
const transcript = (text = "Grüße") => encode({ type: "transcript.done", text, model: "test" });

function setup(overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ release }));
  const chunks = new TransformStream<Uint8Array, Uint8Array>();
  const writer = chunks.writable.getWriter();
  const fetch = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(chunks.readable, {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const events: Array<{ utteranceId: string; state: string }> = [];
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const request = {
    providerConfig: {
      baseUrl: "http://127.0.0.1:8010/v1",
      speechOnsetMs: 40,
      minSpeechMs: 40,
      silenceMs: 200,
      preRollMs: 40,
      maxUtteranceMs: 1_000,
      requestTimeoutMs: 1_000,
      ...overrides,
    },
    onProcessing: (event: { utteranceId: string; state: string }) => events.push(event),
    onTranscript,
    onError,
  };
  const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession(request);
  return { session, events, onTranscript, onError, acquire, release, fetch, writer };
}

describe("realtime transcription processing lifecycle", () => {
  it("reports endpoint before queue/acquire and VAD confirmation before a fragmented UTF-8 transcript", async () => {
    const f = setup();
    await f.session.connect();
    f.session.sendAudio(utterance());
    expect(f.events).toEqual([{ utteranceId: "utterance-1", state: "started" }]);
    expect(f.acquire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    const init = f.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.body as FormData).get("stream")).toBe("true");
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
    await f.writer.write(new TextEncoder().encode(confirmation));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.at(-1)).toEqual({ utteranceId: "utterance-1", state: "speech-confirmed" });
    expect(f.onTranscript).not.toHaveBeenCalled();
    f.onTranscript.mockImplementation(() => {
      expect(f.events.at(-1)?.state).toBe("speech-confirmed");
    });
    for (const byte of new TextEncoder().encode(transcript())) {
      await f.writer.write(Uint8Array.of(byte));
    }
    await f.writer.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).toHaveBeenCalledWith("Grüße", { utteranceId: "utterance-1" });
    expect(f.events.at(-1)).toEqual({ utteranceId: "utterance-1", state: "transcribed" });
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
    f.session.close();
    expect(f.events).toHaveLength(3);
  });

  it.each(["new speech", "duration cap"])(
    "never confirms stale or unfinished speech: %s",
    async (mode) => {
      const f = setup();
      await f.session.connect();
      f.session.sendAudio(mode === "duration cap" ? voiced(50) : utterance());
      if (mode === "new speech") f.session.sendAudio(voiced());
      await vi.advanceTimersByTimeAsync(0);
      await f.writer.write(new TextEncoder().encode(confirmation + transcript()));
      await f.writer.close();
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "duration cap") {
        expect(f.events).toEqual([]);
        expect(f.onTranscript).not.toHaveBeenCalled();
      } else {
        expect(f.events.map((event) => event.state)).toEqual(["started", "transcribed"]);
        expect(f.onTranscript).toHaveBeenCalledOnce();
      }
      f.session.close();
    },
  );

  it("synchronously cancels active and queued IDs exactly once on close", async () => {
    const f = setup();
    await f.session.connect();
    f.session.sendAudio(utterance());
    await vi.advanceTimersByTimeAsync(0);
    f.session.sendAudio(utterance());
    f.session.close();
    f.session.close();
    expect(f.events).toEqual([
      { utteranceId: "utterance-1", state: "started" },
      { utteranceId: "utterance-2", state: "started" },
      { utteranceId: "utterance-1", state: "cancelled" },
      { utteranceId: "utterance-2", state: "cancelled" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.events).toHaveLength(4);
  });

  it.each([
    ["missing terminal", confirmation],
    ["incomplete frame", transcript().trimEnd()],
    ["duplicate terminal", transcript() + transcript()],
    ["late confirmation", transcript() + confirmation],
    ["duplicate confirmation", confirmation + confirmation + transcript()],
    ["malformed JSON", "data: PRIVATE_BACKEND_BODY\n\n"],
    [
      "backend error",
      encode({
        type: "error",
        error: { code: "inference_failed", message: "PRIVATE_BACKEND_BODY", retryable: true },
      }),
    ],
    ["oversized body", ":" + "x".repeat(256 * 1024)],
    ["invalid UTF-8", Uint8Array.of(0x64, 0x61, 0x74, 0x61, 0x3a, 0xff, 0x0a, 0x0a)],
  ])("fails safely on %s without transcript or backend-content exposure", async (_name, wire) => {
    const f = setup();
    await f.session.connect();
    f.session.sendAudio(utterance());
    await vi.advanceTimersByTimeAsync(0);
    await f.writer
      .write(typeof wire === "string" ? new TextEncoder().encode(wire) : wire)
      .catch(() => {});
    await f.writer.close().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.at(-1)).toEqual({ utteranceId: "utterance-1", state: "failed" });
    expect(f.events.filter((event) => event.state === "failed")).toHaveLength(1);
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(String(f.onError.mock.calls[0]?.[0])).not.toContain("PRIVATE_BACKEND_BODY");
    expect(f.release).toHaveBeenCalledOnce();
    f.session.close();
  });

  it("settles a failed active job and cancels its queued successor without starting it", async () => {
    const f = setup();
    await f.session.connect();
    f.session.sendAudio(utterance());
    await vi.advanceTimersByTimeAsync(0);
    f.session.sendAudio(utterance());
    await f.writer.write(new TextEncoder().encode("data: invalid\n\n")).catch(() => {});
    await f.writer.close().catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events).toEqual([
      { utteranceId: "utterance-1", state: "started" },
      { utteranceId: "utterance-2", state: "started" },
      { utteranceId: "utterance-1", state: "failed" },
      { utteranceId: "utterance-2", state: "cancelled" },
    ]);
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
    f.session.close();
  });

  it("does not emit a second terminal when the transcript callback closes synchronously", async () => {
    const f = setup();
    await f.session.connect();
    f.session.sendAudio(utterance());
    await vi.advanceTimersByTimeAsync(0);
    f.onTranscript.mockImplementation(() => f.session.close());
    await f.writer.write(new TextEncoder().encode(confirmation + transcript()));
    await f.writer.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events.map((event) => event.state)).toEqual([
      "started",
      "speech-confirmed",
      "cancelled",
    ]);
    expect(f.onTranscript).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("cancels only accepted IDs on queue overflow before any request starts", async () => {
    const f = setup({ maxQueuedUtterances: 1 });
    await f.session.connect();
    f.session.sendAudio(Buffer.concat([utterance(), utterance()]));
    expect(f.events).toEqual([
      { utteranceId: "utterance-1", state: "started" },
      { utteranceId: "utterance-1", state: "cancelled" },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.onTranscript).not.toHaveBeenCalled();
    f.session.close();
  });

  it("settles empty STT without speech confirmation and times out stalled streams", async () => {
    const empty = setup();
    await empty.session.connect();
    empty.session.sendAudio(utterance());
    await vi.advanceTimersByTimeAsync(0);
    await empty.writer.write(new TextEncoder().encode(transcript("")));
    await empty.writer.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(empty.events.map((event) => event.state)).toEqual(["started", "empty"]);
    expect(empty.onTranscript).not.toHaveBeenCalled();
    empty.session.close();

    const stalled = setup();
    await stalled.session.connect();
    stalled.session.sendAudio(utterance());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stalled.events.map((event) => event.state)).toEqual(["started", "failed"]);
    expect(stalled.release).toHaveBeenCalledOnce();
    expect(stalled.onError).toHaveBeenCalledOnce();
    stalled.session.close();
  });
});
