import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(minSpeechMs = 40) {
  vi.useFakeTimers();
  const release = vi.fn();
  const acquire = vi.fn(async () => ({ release }));
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const fetch = vi.fn(
    async () =>
      new Response(stream.readable, {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const onSpeechActivity = vi.fn();
  const onProcessing = vi.fn();
  const onTranscript = vi.fn();
  const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession({
    providerConfig: {
      baseUrl: "http://127.0.0.1:8010/v1",
      speechOnsetMs: 40,
      minSpeechMs,
      silenceMs: 200,
      preRollMs: 40,
    },
    onSpeechActivity,
    onProcessing,
    onTranscript,
  });
  return { session, acquire, release, fetch, writer, onSpeechActivity, onProcessing, onTranscript };
}

const voiced = (frames = 4) => Buffer.alloc(frames * 160, 0x80);
const quiet = () => Buffer.alloc(10 * 160, 0xff);

describe("explicit transcription capture observations", () => {
  it("reports explicit no-candidate boundaries without a decoder or model request", async () => {
    const f = fixture();
    await f.session.connect();
    f.session.sendAudio(quiet());
    try {
      await expect(f.session.finishInput?.({ captureId: "capture-quiet" })).resolves.toEqual({
        activity: "none",
      });
      expect(f.onSpeechActivity).not.toHaveBeenCalled();
      expect(f.onProcessing).not.toHaveBeenCalled();
      expect(f.onTranscript).not.toHaveBeenCalled();
      expect(f.acquire).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      f.session.close();
    }
  });

  it.each([false, true])(
    "retains a rejected candidate after automatic endpoint: %s",
    async (automatic) => {
      const f = fixture(200);
      await f.session.connect();
      f.session.sendAudio(voiced());
      if (automatic) f.session.sendAudio(quiet());
      try {
        await expect(f.session.finishInput?.({ captureId: "capture-short" })).resolves.toEqual({
          activity: "observed",
        });
        expect(f.onSpeechActivity.mock.calls.map(([event]) => event.state)).toEqual([
          "candidate",
          "rejected",
        ]);
        expect(f.onProcessing).not.toHaveBeenCalled();
        expect(f.fetch).not.toHaveBeenCalled();
      } finally {
        f.session.close();
      }
    },
  );

  it("observes earlier endpoint work without waiting for decoding or replaying it", async () => {
    const f = fixture();
    await f.session.connect();
    f.session.sendAudio(Buffer.concat([voiced(), quiet()]));
    await vi.advanceTimersByTimeAsync(0);
    try {
      const first = f.session.finishInput?.({ captureId: "capture-decoding" });
      await expect(first).resolves.toEqual({ activity: "observed" });
      expect(f.session.finishInput?.({ captureId: "capture-decoding" })).toBe(first);
      expect(f.onTranscript).not.toHaveBeenCalled();
      await f.writer.write(
        new TextEncoder().encode(
          'data: {"type":"speech.confirmed"}\n\n' +
            'data: {"type":"transcript.done","text":"Synthetic request","model":"test"}\n\n',
        ),
      );
      await f.writer.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onProcessing.mock.calls.map(([event]) => event.state)).toEqual([
        "started",
        "speech-confirmed",
        "transcribed",
      ]);
      expect(f.onTranscript).toHaveBeenCalledExactlyOnceWith("Synthetic request", {
        utteranceId: "utterance-1",
      });
    } finally {
      f.session.close();
    }
  });

  it("resets only the completed interval and keeps one duplicate separate from new input", async () => {
    const f = fixture(200);
    await f.session.connect();
    try {
      f.session.sendAudio(voiced());
      const first = f.session.finishInput?.({ captureId: "capture-first" });
      await expect(first).resolves.toEqual({ activity: "observed" });
      f.session.sendAudio(voiced());
      expect(f.session.finishInput?.({ captureId: "capture-first" })).toBe(first);
      await expect(f.session.finishInput?.({ captureId: "capture-next" })).resolves.toEqual({
        activity: "observed",
      });
      f.session.sendAudio(quiet());
      const empty = f.session.finishInput?.({ captureId: "capture-empty" });
      await expect(empty).resolves.toEqual({ activity: "none" });
      expect(f.session.finishInput?.({ captureId: "capture-empty" })).toBe(empty);
      expect(
        f.onSpeechActivity.mock.calls.filter(([event]) => event.state === "candidate"),
      ).toHaveLength(2);
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      f.session.close();
    }
  });

  it("keeps an already transcribed automatic endpoint in the interval", async () => {
    const f = fixture();
    await f.session.connect();
    f.session.sendAudio(Buffer.concat([voiced(), quiet()]));
    await vi.advanceTimersByTimeAsync(0);
    await f.writer.write(
      new TextEncoder().encode(
        'data: {"type":"transcript.done","text":"Finished request","model":"test"}\n\n',
      ),
    );
    await f.writer.close();
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(f.onProcessing.mock.calls.at(-1)?.[0].state).toBe("transcribed");
      await expect(f.session.finishInput?.({ captureId: "capture-finished" })).resolves.toEqual({
        activity: "observed",
      });
      await expect(f.session.finishInput?.({ captureId: "capture-new-empty" })).resolves.toEqual({
        activity: "none",
      });
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.onTranscript).toHaveBeenCalledOnce();
    } finally {
      f.session.close();
    }
  });

  it("observes a transport-gap rejection without submitting a truncated command", async () => {
    const f = fixture(200);
    await f.session.connect();
    f.session.sendAudio(voiced());
    await vi.advanceTimersByTimeAsync(2_000);
    try {
      await expect(f.session.finishInput?.({ captureId: "capture-gap" })).resolves.toEqual({
        activity: "observed",
      });
      expect(f.onSpeechActivity.mock.calls.map(([event]) => event.state)).toEqual([
        "candidate",
        "rejected",
      ]);
      expect(f.fetch).not.toHaveBeenCalled();
      expect(f.onProcessing).not.toHaveBeenCalled();
      expect(f.onTranscript).not.toHaveBeenCalled();
    } finally {
      f.session.close();
    }
  });

  it("keeps legacy no-options calls and real-frame recovery usable", async () => {
    const f = fixture();
    await f.session.connect();
    try {
      f.session.sendAudio(Buffer.alloc(1, 0xff));
      expect(() => f.session.finishInput?.({ captureId: "capture-partial" })).toThrow(
        "complete real audio frames",
      );
      f.session.sendAudio(Buffer.alloc(159, 0xff));
      await expect(f.session.finishInput?.()).resolves.toEqual({ activity: "none" });
      await expect(f.session.finishInput?.({ captureId: "capture-zero" })).resolves.toEqual({
        activity: "none",
      });
      expect(f.fetch).not.toHaveBeenCalled();
    } finally {
      f.session.close();
    }
  });
});
