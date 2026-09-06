import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const FRAME_MS = 20;
const FRAME_BYTES = 8 * FRAME_MS;
const silence = () => Buffer.alloc(FRAME_BYTES, 0xff);
const speech = () => Buffer.alloc(FRAME_BYTES, 0x80);

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

describe("local media realtime transcription provider", () => {
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
      provider.createSession({ providerConfig: requestConfig({ baseUrl: "https://example.test/v1" }) }),
    ).toThrow("requires an explicit loopback HTTP(S) baseUrl");
  });

  it("fails closed when the bounded utterance queue overflows", async () => {
    const acquire = vi.fn().mockResolvedValue({ release: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
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
      expect.objectContaining({ message: "Local media realtime transcription queue limit exceeded" }),
    );
    expect(session.isConnected()).toBe(false);
  });
});
