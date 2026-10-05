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
    vi.mocked(createLiveSpeechProcessor).mockReturnValue({
      connect,
      close,
      send: vi.fn(),
      discardPartialInput: vi.fn(),
    });
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
      discardPartialInput: vi.fn(),
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
      send: (audio) =>
        onFrame({
          audio,
          speechProbability: audio.readInt16LE(0) === 0 ? 0.1 : 0.9,
          gainDb: 0,
          originalRms: Math.abs(audio.readInt16LE(0)) / 32768,
          originalPeak: Math.abs(audio.readInt16LE(0)) / 32768,
        }),
      discardPartialInput: vi.fn(),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ text: "Hallo" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const info = vi.fn();
    const provider = buildLocalRealtimeTranscriptionProvider(
      vi.fn().mockResolvedValue({ release: vi.fn() }),
      { info },
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
    const records = info.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "local_media_stt_utterance",
        outcome: "transcribed",
        meanSpeechProbability: expect.any(Number),
        enhancedRms: expect.any(Number),
        originalRms: expect.any(Number),
        originalPeak: 10_000 / 32_768,
        highProbabilityFrames: 4,
        maxGainDb: 0,
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "local_media_stt_input_summary",
        frontEndInputNearClipSamples: 0,
        frontEndOutputNearClipSamples: 0,
        highProbabilityGainFrames: 0,
        highProbabilityMeanGainDb: null,
        uncertainProbabilityGainFrames: 5,
        uncertainProbabilityMeanGainDb: 0,
        lowProbabilityGainFrames: 10,
        lowProbabilityMeanGainDb: 0,
        longestLowProbabilityStreakMs: 200,
        maxLowProbabilityStreakGainRiseDb: 0,
      }),
    );
  });

  it("upsamples legacy mu-law callers into the same live speech path", async () => {
    const send = vi.fn();
    vi.mocked(createLiveSpeechProcessor).mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send,
      discardPartialInput: vi.fn(),
    });
    const provider = buildLocalRealtimeTranscriptionProvider(vi.fn());
    const session = provider.createSession({ providerConfig });
    await session.connect();
    session.sendAudio(Buffer.alloc(160, 0xff));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toHaveLength(640);
    session.close();
  });

  it("counts clipping before and after the front end without retaining audio", async () => {
    vi.mocked(createLiveSpeechProcessor).mockImplementation(({ onFrame }) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send: () =>
        onFrame({
          audio: Buffer.alloc(640),
          speechProbability: 0,
          gainDb: 0,
          originalRms: 1,
          originalPeak: 1,
        }),
      discardPartialInput: vi.fn(),
    }));
    const info = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(vi.fn(), { info }).createSession({
      providerConfig,
      inputAudioFormat: "pcm16-16khz",
    });
    await session.connect();
    const clippedInput = Buffer.alloc(640);
    for (let offset = 0; offset < clippedInput.byteLength; offset += 2) {
      clippedInput.writeInt16LE(32_767, offset);
    }
    session.sendAudio(clippedInput);
    session.close();
    expect(info.mock.calls.map(([line]) => JSON.parse(line as string))).toContainEqual(
      expect.objectContaining({
        event: "local_media_stt_input_summary",
        frontEndInputNearClipSamples: 320,
        frontEndOutputNearClipSamples: 0,
      }),
    );
  });

  it("keeps amplified road noise and brief impacts out of a call turn", async () => {
    let probability = 0.2;
    let gainDb = 12;
    vi.mocked(createLiveSpeechProcessor).mockImplementation(({ onFrame }) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send: (audio) =>
        onFrame({
          audio,
          speechProbability: probability,
          gainDb,
          originalRms: Math.abs(audio.readInt16LE(0)) / 32768,
          originalPeak: Math.abs(audio.readInt16LE(0)) / 32768,
        }),
      discardPartialInput: vi.fn(),
    }));
    const onSpeechStart = vi.fn();
    const activity: string[] = [];
    const session = buildLocalRealtimeTranscriptionProvider(vi.fn()).createSession({
      providerConfig: { ...providerConfig, speechOnsetMs: 80, minSpeechMs: 80 },
      inputAudioFormat: "pcm16-16khz",
      onSpeechStart,
      onSpeechActivity: ({ state }) => activity.push(state),
    });
    const frame = (sample: number) => {
      const audio = Buffer.alloc(640);
      for (let offset = 0; offset < audio.byteLength; offset += 2) {
        audio.writeInt16LE(sample, offset);
      }
      session.sendAudio(audio);
    };
    await session.connect();
    for (let index = 0; index < 50; index += 1) frame(1_000);
    probability = 0.95;
    frame(20_000);
    frame(20_000);
    probability = 0.1;
    frame(0);
    expect(onSpeechStart).not.toHaveBeenCalled();
    probability = 0.9;
    gainDb = 6;
    for (let index = 0; index < 5; index += 1) frame(500);
    expect(onSpeechStart).toHaveBeenCalledOnce();
    expect(activity).toEqual(["candidate", "sustained"]);
    session.close();
  });

  it("uses confirmed STT evidence to admit later quiet speech only in the same call", async () => {
    vi.mocked(createLiveSpeechProcessor).mockImplementation(({ onFrame }) => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      send: (audio) =>
        onFrame({
          audio,
          speechProbability: audio.readInt16LE(0) === 0 ? 0.1 : 0.9,
          gainDb: 0,
          originalRms: Math.abs(audio.readInt16LE(0)) / 32768,
          originalPeak: Math.abs(audio.readInt16LE(0)) / 32768,
        }),
      discardPartialInput: vi.fn(),
    }));
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          event({ type: "speech.confirmed" }) +
            event({
              type: "transcript.done",
              text: "Hallo",
              model: "test",
              recognition: {
                audioDurationMs: 700,
                speechDurationMs: 500,
                segmentCount: 1,
                signals: [],
              },
            }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSpeechStart = vi.fn();
    const onTranscript = vi.fn();
    const session = buildLocalRealtimeTranscriptionProvider(
      vi.fn().mockResolvedValue({ release: vi.fn() }),
    ).createSession({
      providerConfig: { ...providerConfig, speechOnsetMs: 40, silenceMs: 200 },
      inputAudioFormat: "pcm16-16khz",
      onSpeechStart,
      onProcessing: vi.fn(),
      onTranscript,
    });
    const frame = (sample: number) => {
      const audio = Buffer.alloc(640);
      for (let offset = 0; offset < audio.byteLength; offset += 2) {
        audio.writeInt16LE(sample, offset);
      }
      session.sendAudio(audio);
    };
    await session.connect();
    for (let index = 0; index < 20; index += 1) frame(260);
    for (let index = 0; index < 10; index += 1) frame(0);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 10; index += 1) frame(230);
    for (let index = 0; index < 10; index += 1) frame(0);
    await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledTimes(2));
    expect(onSpeechStart).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    session.close();
  });
});
