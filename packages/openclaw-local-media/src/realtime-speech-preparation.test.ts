import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveSpeechProcessor } from "./live-speech-processor.js";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

vi.mock("./live-speech-processor.js", () => ({ createLiveSpeechProcessor: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("realtime speech readiness", () => {
  const providerConfig = {
    baseUrl: "http://127.0.0.1:8010/v1",
    speechProcessorPython: "/opt/stt/bin/python",
  };

  it("selects linear audio and checks native readiness before accepting a call", async () => {
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    vi.mocked(createLiveSpeechProcessor).mockReturnValue({ connect, close, send: vi.fn() });
    const provider = buildLocalRealtimeTranscriptionProvider(
      vi.fn().mockResolvedValue({ release }),
    );

    expect(provider.resolveInputAudioFormat?.(providerConfig)).toBe("pcm16-16khz");
    const lease = await provider.prepareSession({ providerConfig });
    expect(createLiveSpeechProcessor).toHaveBeenCalledWith(
      expect.objectContaining({ python: "/opt/stt/bin/python" }),
    );
    expect(connect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    await lease?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases the STT lease when processor readiness fails", async () => {
    const release = vi.fn();
    const close = vi.fn();
    vi.mocked(createLiveSpeechProcessor).mockReturnValue({
      connect: vi.fn().mockRejectedValue(new Error("processor unavailable")),
      close,
      send: vi.fn(),
    });
    const provider = buildLocalRealtimeTranscriptionProvider(
      vi.fn().mockResolvedValue({ release }),
    );
    await expect(provider.prepareSession({ providerConfig })).rejects.toThrow(
      "processor unavailable",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("sends enhanced 16 kHz frames through the onset gate without a second pass", async () => {
    vi.mocked(createLiveSpeechProcessor).mockImplementation(({ onFrame }) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send: onFrame,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: "Hallo" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const provider = buildLocalRealtimeTranscriptionProvider(
      vi.fn().mockResolvedValue({ release: vi.fn() }),
    );
    const session = provider.createSession({
      providerConfig: { ...providerConfig, speechOnsetMs: 40, silenceMs: 200, minSpeechMs: 40 },
      inputAudioFormat: "pcm16-16khz",
      onTranscript,
      onError,
    });
    await session.connect();
    const voice = Buffer.alloc(640);
    for (let offset = 0; offset < voice.byteLength; offset += 2) {
      voice.writeInt16LE(10_000, offset);
    }
    for (let index = 0; index < 5; index += 1) session.sendAudio(voice);
    for (let index = 0; index < 10; index += 1) session.sendAudio(Buffer.alloc(640));
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Hallo"));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const form = init.body as FormData;
    const wav = Buffer.from(await (form.get("file") as File).arrayBuffer());
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(new Headers(init.headers).has("x-openclaw-speech-input")).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    session.close();
  });

  it("upsamples legacy mu-law callers into the same live speech path", async () => {
    const send = vi.fn();
    vi.mocked(createLiveSpeechProcessor).mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send,
    });
    const provider = buildLocalRealtimeTranscriptionProvider(vi.fn());
    const session = provider.createSession({ providerConfig });
    await session.connect();
    session.sendAudio(Buffer.alloc(160, 0xff));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toHaveLength(640);
    session.close();
  });
});
