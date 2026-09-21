import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const FRAME_MS = 20;
const FRAME_BYTES = 8 * FRAME_MS;
const silence = () => Buffer.alloc(FRAME_BYTES, 0xff);
const speech = () => Buffer.alloc(FRAME_BYTES, 0x80);

function sendFragments(
  session: { sendAudio(audio: Buffer): void },
  audio: Buffer,
  sizes: number[],
) {
  let offset = 0;
  let index = 0;
  while (offset < audio.length) {
    const size = sizes[index % sizes.length] ?? audio.length;
    session.sendAudio(audio.subarray(offset, offset + size));
    offset += size;
    index += 1;
  }
}

function requestConfig(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://127.0.0.1:8010/v1",
    speechOnsetMs: 40,
    silenceMs: 200,
    preRollMs: 20,
    minSpeechMs: 40,
    maxUtteranceMs: 2_000,
    requestTimeoutMs: 1_000,
    maxQueuedUtterances: 2,
    ...overrides,
  };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

function diagnostics(info: ReturnType<typeof vi.fn>, event: string) {
  return info.mock.calls
    .map(([message]) => JSON.parse(message as string) as Record<string, unknown>)
    .filter((record) => record.event === event);
}

describe("local media realtime transcription provider", () => {
  it("separates queue, acquire and complete HTTP timings without exposing content", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const release = vi.fn();
    const acquire = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 17));
      return { release };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 23));
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify({ text: "PRIVATE_TRANSCRIPT" })),
                );
                controller.close();
              }, 11);
            },
          }),
        );
      }),
    );
    const info = vi.fn();
    const onTranscript = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire, { info }).createSession({
      providerConfig: requestConfig({ model: "PRIVATE_MODEL" }),
      onTranscript,
    });
    await session.connect();
    const utterance = Buffer.concat([speech(), speech(), ...Array.from({ length: 10 }, silence)]);
    session.sendAudio(Buffer.concat([utterance, utterance]));
    await vi.advanceTimersByTimeAsync(102);
    expect(onTranscript).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    const records = diagnostics(info, "local_media_stt_utterance");
    expect(records).toEqual(
      [0, 51].map((queueWaitMs) => ({
        event: "local_media_stt_utterance",
        outcome: "transcribed",
        queueWaitMs,
        acquireMs: 17,
        httpMs: 34,
        endpointToTranscriptMs: queueWaitMs + 51,
        endpointSilenceWallMs: 0,
        trailingSilenceAudioMs: 200,
        utteranceAudioMs: 220,
      })),
    );
    session.close();
    session.close();
    expect(diagnostics(info, "local_media_stt_input_summary")).toHaveLength(1);
    const logged = JSON.stringify(info.mock.calls);
    for (const privateValue of [
      "PRIVATE_TRANSCRIPT",
      "PRIVATE_MODEL",
      "127.0.0.1",
      "utterance.wav",
    ]) {
      expect(logged).not.toContain(privateValue);
    }
  });

  it("measures missing input time without using wall time to endpoint speech", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const acquire = vi.fn().mockResolvedValue({ release: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ text: "Recognized" })),
    );
    const info = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire, { info }).createSession({
      providerConfig: requestConfig({
        speechOnsetMs: 80,
        minSpeechMs: 80,
        preRollMs: 80,
        silenceMs: 700,
      }),
    });
    await session.connect();
    session.sendAudio(Buffer.concat(Array.from({ length: 4 }, speech)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(acquire).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    session.sendAudio(Buffer.concat(Array.from({ length: 35 }, silence)));
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostics(info, "local_media_stt_utterance")).toEqual([
      expect.objectContaining({
        outcome: "transcribed",
        endpointSilenceWallMs: 1_000,
        trailingSilenceAudioMs: 700,
        utteranceAudioMs: 780,
      }),
    ]);
    session.close();
    expect(diagnostics(info, "local_media_stt_input_summary")).toEqual([
      expect.objectContaining({
        count: 2,
        audioMs: 780,
        maxPacketAudioMs: 700,
        maxInputGapMs: 1_000,
        elapsedMs: 1_000,
        inputIdleMs: 0,
        frames: 39,
        loudFrames: 4,
        maxConsecutiveLoudMs: 80,
        speechStarts: 1,
        completed: 1,
        dropped: 0,
      }),
    ]);
    const interrupted = buildLocalRealtimeTranscriptionProvider(acquire, { info }).createSession({
      providerConfig: requestConfig({
        speechOnsetMs: 80,
        minSpeechMs: 80,
        preRollMs: 80,
        silenceMs: 700,
      }),
    });
    await interrupted.connect();
    interrupted.sendAudio(Buffer.concat(Array.from({ length: 4 }, speech)));
    await vi.advanceTimersByTimeAsync(1_000);
    interrupted.close();
    interrupted.close();
    expect(acquire).toHaveBeenCalledOnce();
    expect(diagnostics(info, "local_media_stt_input_summary")).toHaveLength(2);
    expect(diagnostics(info, "local_media_stt_input_summary")[1]).toEqual(
      expect.objectContaining({
        elapsedMs: 1_000,
        inputIdleMs: 1_000,
        audioMs: 80,
        speechStarts: 1,
        endpoints: 0,
        completed: 0,
        dropped: 1,
      }),
    );
    expect(diagnostics(info, "local_media_stt_utterance")[1]).toEqual(
      expect.objectContaining({
        outcome: "cancelled",
        queueWaitMs: null,
        acquireMs: null,
        httpMs: null,
        endpointToTranscriptMs: null,
      }),
    );
  });

  it("does not let diagnostic logger failures interrupt media or cleanup", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ release });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ text: "Recognized" })),
    );
    const info = vi.fn(() => {
      throw new Error("Logger unavailable");
    });
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire, { info }).createSession({
      providerConfig: requestConfig(),
      onTranscript,
      onError,
    });
    await session.connect();
    session.sendAudio(Buffer.concat([speech(), speech(), ...Array.from({ length: 10 }, silence)]));
    await waitFor(() => onTranscript.mock.calls.length === 1);
    expect(onTranscript).toHaveBeenCalledWith("Recognized");
    expect(release).toHaveBeenCalledOnce();
    expect(() => session.close()).not.toThrow();
    expect(info).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    ["aligned", [FRAME_BYTES]],
    ["coalesced", [10_000]],
    ["irregular", [7, 319, 51, 163]],
    ["byte fragments", [1]],
  ])("keeps onset and WAV independent of %s delivery", async (_name, sizes) => {
    const acquire = vi.fn().mockResolvedValue({ release: vi.fn() });
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ text: "Recognized" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession({
      providerConfig: requestConfig({ preRollMs: 60 }),
      onSpeechStart,
      onTranscript,
    });
    // Every 20-ms frame is speech, but individual samples are mostly quiet.
    // Transport fragments must not become independent VAD decisions.
    const voicedFrame = silence();
    voicedFrame.fill(0x80, 0, 8);
    const audio = Buffer.concat([
      silence(),
      ...Array.from({ length: 4 }, () => voicedFrame),
      ...Array.from({ length: 10 }, silence),
    ]);
    await session.connect();
    const onsetEnd = 3 * FRAME_BYTES;
    sendFragments(session, audio.subarray(0, onsetEnd - 1), sizes);
    expect(onSpeechStart).not.toHaveBeenCalled();
    session.sendAudio(audio.subarray(onsetEnd - 1, onsetEnd));
    expect(onSpeechStart).toHaveBeenCalledOnce();
    sendFragments(session, audio.subarray(onsetEnd), sizes);
    await waitFor(() => onTranscript.mock.calls.length === 1);

    expect(fetchMock).toHaveBeenCalledOnce();
    const form = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as FormData;
    const wav = Buffer.from(await (form.get("file") as File).arrayBuffer());
    const expectedPcm = Buffer.alloc(audio.length * 2);
    for (let index = 0; index < audio.length; index += 1) {
      expectedPcm.writeInt16LE(audio[index] === 0x80 ? 32_124 : 0, index * 2);
    }
    expect(wav.readUInt32LE(24)).toBe(8_000);
    expect(wav.readUInt32LE(40)).toBe(expectedPcm.length);
    expect(wav.subarray(44)).toEqual(expectedPcm);
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("Recognized");
    session.close();
  });

  it("discards a partial analysis frame on close", async () => {
    const acquire = vi.fn();
    const onSpeechStart = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession({
      providerConfig: requestConfig({ speechOnsetMs: 20 }),
      onSpeechStart,
    });
    await session.connect();
    session.sendAudio(speech().subarray(0, FRAME_BYTES - 1));
    session.close();
    session.sendAudio(Buffer.concat([speech(), ...Array.from({ length: 10 }, silence)]));
    expect(onSpeechStart).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    await expect(session.connect()).rejects.toThrow("session is closed");
  });

  it("stops processing a coalesced packet when the utterance queue overflows", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ release });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => Response.json({ text: "late" })),
    );
    const onError = vi.fn();
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession({
      providerConfig: requestConfig({ maxQueuedUtterances: 1 }),
      onError,
      onSpeechStart,
      onTranscript,
    });
    await session.connect();
    const utterance = Buffer.concat([speech(), speech(), ...Array.from({ length: 10 }, silence)]);
    session.sendAudio(Buffer.concat([utterance, utterance, speech(), speech().subarray(0, 79)]));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "Local media realtime transcription queue limit exceeded",
      }),
    );
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(session.isConnected()).toBe(false);
    session.sendAudio(speech());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("aborts active transcription and skips queued utterances on close", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ release });
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      fetchSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          {
            once: true,
          },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const info = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(acquire, { info }).createSession({
      providerConfig: requestConfig(),
      onError,
      onTranscript,
    });
    await session.connect();
    const utterance = Buffer.concat([speech(), speech(), ...Array.from({ length: 10 }, silence)]);
    session.sendAudio(utterance);
    await waitFor(() => fetchMock.mock.calls.length === 1);
    session.sendAudio(utterance);
    session.sendAudio(speech().subarray(0, 79));
    session.close();
    expect(fetchSignal?.aborted).toBe(true);
    await waitFor(() => release.mock.calls.length === 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acquire).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
    expect(diagnostics(info, "local_media_stt_utterance")).toEqual([
      expect.objectContaining({ outcome: "cancelled", endpointToTranscriptMs: null }),
      expect.objectContaining({
        outcome: "cancelled",
        acquireMs: null,
        httpMs: null,
        endpointToTranscriptMs: null,
      }),
    ]);
    expect(diagnostics(info, "local_media_stt_input_summary")).toHaveLength(1);
  });

  it("clears the transcription deadline when lease acquisition fails", async () => {
    vi.useFakeTimers();
    try {
      const acquire = vi.fn().mockRejectedValue(new Error("Worker unavailable"));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const onError = vi.fn();
      const info = vi.fn();
      const session = buildLocalRealtimeTranscriptionProvider(acquire, { info }).createSession({
        providerConfig: requestConfig(),
        onError,
      });
      await session.connect();
      session.sendAudio(
        Buffer.concat([speech(), speech(), ...Array.from({ length: 10 }, silence)]),
      );
      // Flush the promise-only lease failure, without expiring its deadline.
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0]?.[0]).toEqual(new Error("Worker unavailable"));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(session.isConnected()).toBe(false);
      expect(diagnostics(info, "local_media_stt_utterance")).toEqual([
        expect.objectContaining({ outcome: "failed", httpMs: null, endpointToTranscriptMs: null }),
      ]);
      expect(diagnostics(info, "local_media_stt_input_summary")).toHaveLength(1);
      expect(JSON.stringify(info.mock.calls)).not.toContain("Worker unavailable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prepares and retains the worker before a realtime session starts", async () => {
    const lease = { release: vi.fn() };
    const acquire = vi.fn().mockResolvedValue(lease);
    const provider = buildLocalRealtimeTranscriptionProvider(acquire);
    const signal = new AbortController().signal;
    expect(provider.transcriptGranularity).toBe("utterance");

    await expect(
      provider.prepareSession({ providerConfig: requestConfig(), signal }),
    ).resolves.toBe(lease);
    expect(acquire).toHaveBeenCalledWith(
      { providerId: "local-media", baseUrl: "http://127.0.0.1:8010/v1" },
      signal,
    );
  });

  it("segments mu-law speech, acquires a lease, and submits an 8 kHz WAV", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ release });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "Guten Morgen" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const provider = buildLocalRealtimeTranscriptionProvider(acquire);
    const session = provider.createSession({
      providerConfig: requestConfig(),
      onSpeechStart,
      onTranscript,
    });

    await session.connect();
    session.sendAudio(silence());
    session.sendAudio(speech());
    session.sendAudio(speech());
    for (let index = 0; index < 10; index += 1) {
      session.sendAudio(silence());
    }
    await waitFor(() => onTranscript.mock.calls.length === 1);

    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("Guten Morgen");
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "local-media",
        baseUrl: "http://127.0.0.1:8010/v1",
      }),
      expect.any(AbortSignal),
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8010/v1/audio/transcriptions");
    const form = init.body as FormData;
    const file = form.get("file") as File;
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(8_000);
    expect(form.get("model")).toBe("faster-whisper");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not submit silence", async () => {
    const acquire = vi.fn();
    const provider = buildLocalRealtimeTranscriptionProvider(acquire);
    const session = provider.createSession({ providerConfig: requestConfig() });
    await session.connect();
    for (let index = 0; index < 20; index += 1) {
      session.sendAudio(silence());
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it("rejects non-loopback endpoints before opening a session", () => {
    const provider = buildLocalRealtimeTranscriptionProvider(vi.fn());
    expect(() =>
      provider.createSession({
        providerConfig: requestConfig({ baseUrl: "https://example.test/v1" }),
      }),
    ).toThrow("requires an explicit loopback HTTP(S) baseUrl");
  });

  it("fails closed when the bounded utterance queue overflows", async () => {
    const acquire = vi.fn().mockResolvedValue({ release: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const onError = vi.fn();
    const provider = buildLocalRealtimeTranscriptionProvider(acquire);
    const session = provider.createSession({
      providerConfig: requestConfig({ maxQueuedUtterances: 1 }),
      onError,
    });
    await session.connect();
    const utterance = () => {
      session.sendAudio(speech());
      session.sendAudio(speech());
      for (let index = 0; index < 10; index += 1) {
        session.sendAudio(silence());
      }
    };
    utterance();
    utterance();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: "Local media realtime transcription queue limit exceeded",
      }),
    );
    expect(session.isConnected()).toBe(false);
  });
});
