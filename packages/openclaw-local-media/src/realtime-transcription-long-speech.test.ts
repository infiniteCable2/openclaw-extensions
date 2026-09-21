import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const speech = (ms: number) => Buffer.alloc(ms * 8, 0x80);
const silence = (ms = 700) => Buffer.alloc(ms * 8, 0xff);
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

function deferredResponse() {
  let resolve!: (value: Response) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(
  streaming: boolean,
  texts: string[] = ["First part", "last part", "next turn"],
  providerConfig: Record<string, unknown> = {},
) {
  vi.useFakeTimers();
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ release }));
  const onTranscript = vi.fn();
  const onPartial = vi.fn();
  const onSpeechStart = vi.fn();
  const onError = vi.fn();
  const onProcessing = vi.fn();
  let responseIndex = 0;
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    const text = texts[responseIndex++] ?? "";
    return streaming
      ? new Response(
          (text ? event({ type: "speech.confirmed" }) : "") +
            event({ type: "transcript.done", text, model: "test" }),
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      : Response.json({ text });
  });
  vi.stubGlobal("fetch", fetch);
  const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession({
    providerConfig: { baseUrl: "http://127.0.0.1:8010/v1", ...providerConfig },
    onTranscript,
    onPartial,
    onSpeechStart,
    onError,
    ...(streaming ? { onProcessing } : {}),
  });
  return {
    session,
    fetch,
    acquire,
    release,
    onTranscript,
    onPartial,
    onSpeechStart,
    onError,
    onProcessing,
  };
}

describe("continuous speech across bounded STT batches", () => {
  it("retains initial bounded batches when minimum speech exceeds the batch cap", async () => {
    const f = fixture(true, ["Beginning", "middle", "ending", ""], {
      maxUtteranceMs: 1_000,
      minSpeechMs: 3_000,
    });
    await f.session.connect();
    for (let batch = 1; batch <= 3; batch += 1) {
      f.session.sendAudio(speech(1_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledTimes(batch);
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onProcessing).not.toHaveBeenCalled();
      if (batch < 3) expect(f.onPartial).not.toHaveBeenCalled();
    }
    f.session.sendAudio(silence());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).toHaveBeenCalledExactlyOnceWith("Beginning middle ending", {
      utteranceId: "utterance-1",
    });
    expect(f.release).toHaveBeenCalledTimes(4);
    expect(f.onError).not.toHaveBeenCalled();
    f.session.close();
  });

  it("discards late results from a size batch when the completed turn is below minimum speech", async () => {
    const f = fixture(true, ["Accepted turn"], {
      maxUtteranceMs: 1_000,
      minSpeechMs: 3_000,
    });
    const first = deferredResponse();
    f.fetch.mockImplementationOnce(() => first.promise);
    await f.session.connect();
    f.session.sendAudio(speech(1_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledOnce();
    f.session.sendAudio(silence());
    first.resolve(
      new Response(
        event({ type: "speech.confirmed" }) +
          event({ type: "transcript.done", text: "Rejected words", model: "test" }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onPartial).not.toHaveBeenCalled();
    expect(f.onProcessing).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.session.isConnected()).toBe(true);
    f.session.close();
  });

  it("fails the admitted turn when its earlier nonfinal batch rejects", async () => {
    const f = fixture(true, [], { maxQueuedUtterances: 3 });
    const first = deferredResponse();
    f.fetch.mockImplementationOnce(() => first.promise);
    await f.session.connect();
    f.session.sendAudio(speech(30_000));
    await vi.advanceTimersByTimeAsync(0);
    f.session.sendAudio(Buffer.concat([speech(200), silence()]));
    f.session.sendAudio(Buffer.concat([speech(200), silence()]));
    first.reject(new Error("Synthetic earlier batch failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onProcessing.mock.calls.map(([value]) => value)).toEqual([
      { utteranceId: "utterance-1", state: "started" },
      { utteranceId: "utterance-2", state: "started" },
      { utteranceId: "utterance-1", state: "failed" },
      { utteranceId: "utterance-2", state: "cancelled" },
    ]);
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onPartial).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.session.isConnected()).toBe(false);
    f.session.close();
  });

  it.each([false, true])(
    "waits for silence after 40 seconds, preserving text and one onset (stream=%s)",
    async (streaming) => {
      const f = fixture(streaming);
      await f.session.connect();
      f.session.sendAudio(speech(30_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.onProcessing).not.toHaveBeenCalled();
      expect(f.onPartial).toHaveBeenLastCalledWith("First part");
      f.session.sendAudio(speech(10_000));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onSpeechStart).toHaveBeenCalledOnce();
      expect(f.onTranscript).not.toHaveBeenCalled();
      f.session.sendAudio(silence());
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.onTranscript).toHaveBeenCalledTimes(1);
      if (streaming) {
        expect(f.onTranscript).toHaveBeenCalledWith("First part last part", {
          utteranceId: "utterance-1",
        });
        expect(f.onProcessing.mock.calls.map(([value]) => value.state)).toEqual([
          "started",
          "speech-confirmed",
          "transcribed",
        ]);
      } else {
        expect(f.onTranscript).toHaveBeenCalledWith("First part last part");
      }
      const audioMs = await Promise.all(
        f.fetch.mock.calls.map(async ([, init]) => {
          const file = (init?.body as FormData).get("file") as File;
          return ((await file.arrayBuffer()).byteLength - 44) / 16;
        }),
      );
      expect(audioMs).toEqual([30_000, 10_700]);
      f.session.sendAudio(Buffer.concat([speech(200), silence()]));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.onTranscript.mock.calls[1]?.[0]).toBe("next turn");
      expect(f.onSpeechStart).toHaveBeenCalledTimes(2);
      expect(f.release).toHaveBeenCalledTimes(3);
      expect(f.onError).not.toHaveBeenCalled();
      f.session.close();
    },
  );

  it("keeps completed batch text when the final tail contains only silence", async () => {
    const f = fixture(true, ["Complete words", ""]);
    await f.session.connect();
    f.session.sendAudio(speech(30_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).not.toHaveBeenCalled();
    f.session.sendAudio(silence());
    expect(f.onProcessing.mock.calls.map(([value]) => value.state)).toEqual([
      "started",
      "speech-confirmed",
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).toHaveBeenCalledExactlyOnceWith("Complete words", {
      utteranceId: "utterance-1",
    });
    expect(f.onProcessing.mock.calls.map(([value]) => value.state)).toEqual([
      "started",
      "speech-confirmed",
      "transcribed",
    ]);
    f.session.close();
  });

  it("discards partial turn text on close instead of finalizing it", async () => {
    const f = fixture(true);
    await f.session.connect();
    f.session.sendAudio(speech(30_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onPartial).toHaveBeenCalledOnce();
    f.session.close();
    f.session.sendAudio(silence());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onProcessing).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("keeps a silence-ended tail queued behind its earlier batch and never dispatches a partial on failure", async () => {
    const f = fixture(true);
    const first = deferredResponse();
    f.fetch.mockImplementationOnce(() => first.promise);
    f.fetch.mockRejectedValueOnce(new Error("Synthetic request failure"));
    await f.session.connect();
    f.session.sendAudio(speech(30_000));
    await vi.advanceTimersByTimeAsync(0);
    f.session.sendAudio(Buffer.concat([speech(200), silence()]));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onProcessing.mock.calls.map(([value]) => value.state)).toEqual(["started"]);
    first.resolve(
      new Response(
        event({ type: "speech.confirmed" }) +
          event({ type: "transcript.done", text: "Prefix", model: "test" }),
        {
          headers: { "content-type": "text/event-stream" },
        },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.onPartial).toHaveBeenCalledExactlyOnceWith("Prefix");
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onProcessing.mock.calls.map(([value]) => value.state)).toEqual([
      "started",
      "speech-confirmed",
      "failed",
    ]);
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.onError).toHaveBeenCalledOnce();
    f.session.close();
  });

  it("fails closed at the existing audio queue bound without dispatching any part of a continuous turn", async () => {
    const f = fixture(true);
    await f.session.connect();
    f.session.sendAudio(speech(90_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.onPartial).not.toHaveBeenCalled();
    expect(f.onProcessing).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.session.isConnected()).toBe(false);
    f.session.close();
  });

  it("keeps overlapping completed turns isolated and suppresses old-turn confirmations", async () => {
    const f = fixture(true, ["First part", "next turn"]);
    await f.session.connect();
    f.session.sendAudio(speech(30_000));
    await vi.advanceTimersByTimeAsync(0);
    const tail = deferredResponse();
    f.fetch.mockImplementationOnce(() => tail.promise);
    f.session.sendAudio(Buffer.concat([speech(200), silence()]));
    await vi.advanceTimersByTimeAsync(0);
    f.session.sendAudio(Buffer.concat([speech(200), silence()]));
    expect(f.onTranscript).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    tail.resolve(
      new Response(
        event({ type: "speech.confirmed" }) +
          event({ type: "transcript.done", text: "last part", model: "test" }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript.mock.calls).toEqual([
      ["First part last part", { utteranceId: "utterance-1" }],
      ["next turn", { utteranceId: "utterance-2" }],
    ]);
    expect(f.onProcessing.mock.calls.map(([value]) => value)).toEqual([
      { utteranceId: "utterance-1", state: "started" },
      { utteranceId: "utterance-1", state: "speech-confirmed" },
      { utteranceId: "utterance-2", state: "started" },
      { utteranceId: "utterance-1", state: "transcribed" },
      { utteranceId: "utterance-2", state: "speech-confirmed" },
      { utteranceId: "utterance-2", state: "transcribed" },
    ]);
    expect(f.release).toHaveBeenCalledTimes(3);
    expect(f.onError).not.toHaveBeenCalled();
    f.session.close();
  });

  it("fails without a truncated final transcript when accumulated UTF-8 exceeds the bounded response budget", async () => {
    const f = fixture(true, ["é".repeat(80_000), "é".repeat(80_000)]);
    await f.session.connect();
    f.session.sendAudio(speech(30_000));
    await vi.advanceTimersByTimeAsync(0);
    f.session.sendAudio(Buffer.concat([speech(200), silence()]));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onTranscript.mock.calls.length).toBe(0);
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.onProcessing.mock.calls.at(-1)?.[0]).toEqual({
      utteranceId: "utterance-1",
      state: "failed",
    });
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.session.isConnected()).toBe(false);
    f.session.close();
  });
});
