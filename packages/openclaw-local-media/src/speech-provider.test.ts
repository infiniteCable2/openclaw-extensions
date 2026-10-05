import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalMediaSpeechProvider } from "./speech-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function configuredProvider(logger?: Parameters<typeof buildLocalMediaSpeechProvider>[0]) {
  const provider = buildLocalMediaSpeechProvider(logger);
  const providerConfig = provider.resolveConfig?.({
    cfg: {} as never,
    rawConfig: {
      providers: {
        "local-media": {
          baseUrl: "http://127.0.0.1:8020/v1",
          model: "test-voice-model",
          voice: "nova",
        },
      },
    },
    timeoutMs: 1_000,
  });
  if (!providerConfig) {
    throw new Error("provider config was not resolved");
  }
  return { provider, providerConfig };
}

function framedPcmStream(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  const chunks = frames.flatMap((frame) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(frame.byteLength);
    return [header, Buffer.from(frame)];
  });
  chunks.push(Buffer.alloc(4));
  const wire = Buffer.concat(chunks);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(wire.subarray(0, 3));
      controller.enqueue(wire.subarray(3, 9));
      controller.enqueue(wire.subarray(9));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks;
}

describe("local media speech provider", () => {
  it("drops prefetched PCM when the caller aborts between frames", async () => {
    const upstreamCancel = vi.fn();
    const frame = Buffer.from([0, 0, 0, 2, 1, 2]);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.concat([frame, frame]));
      },
      cancel: upstreamCancel,
    });
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/cancel")
        ? new Response(null, { status: 204 })
        : new Response(body, {
            headers: {
              "content-type": "application/vnd.openclaw.pcm-stream",
              "x-openclaw-audio-sample-rate": "24000",
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();
    const caller = new AbortController();
    const result = await provider.streamSynthesizeTelephony({
      text: "Two parts",
      providerConfig,
      timeoutMs: 1_000,
      signal: caller.signal,
    });
    const reader = result.audioStream.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false, value: Uint8Array.of(1, 2) });
    // Let the default stream high-water mark prefetch the second local frame.
    await Promise.resolve();
    await Promise.resolve();
    caller.abort(new Error("Caller interrupted"));
    await expect(reader.read()).rejects.toThrow("Caller interrupted");
    expect(upstreamCancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/cancel"))).toHaveLength(1);
  });

  it("cancels a pending PCM read before the service cancellation HTTP request finishes", async () => {
    const upstreamCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: upstreamCancel });
    let finishCancel!: (response: Response) => void;
    const cancellationResponse = new Promise<Response>((resolve) => {
      finishCancel = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/cancel")
          ? cancellationResponse
          : new Response(body, {
              headers: {
                "content-type": "application/vnd.openclaw.pcm-stream",
                "x-openclaw-audio-sample-rate": "24000",
              },
            }),
      ),
    );
    const { provider, providerConfig } = configuredProvider();
    const caller = new AbortController();
    const result = await provider.streamSynthesizeTelephony({
      text: "Pending",
      providerConfig,
      timeoutMs: 1_000,
      signal: caller.signal,
    });
    const reader = result.audioStream.getReader();
    const reading = reader.read();
    caller.abort(new Error("Stop now"));
    expect(upstreamCancel).toHaveBeenCalledOnce();
    await expect(reading).rejects.toThrow("Stop now");
    finishCancel(new Response(null, { status: 204 }));
    await Promise.resolve();
  });
  it("renders a Matrix-compatible Opus voice note", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/ogg", "content-length": "3" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();

    await expect(
      provider.synthesize({
        text: "Hallo Beispielnutzer",
        cfg: {} as never,
        providerConfig,
        target: "voice-note",
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      audioBuffer: Buffer.from([1, 2, 3]),
      outputFormat: "opus",
      fileExtension: ".ogg",
      voiceCompatible: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8020/v1/audio/speech");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(String(init.body))).toEqual({
      input: "Hallo Beispielnutzer",
      model: "test-voice-model",
      voice: "nova",
      response_format: "opus",
    });
  });

  it("reports only request identity, stage, status, and duration for voice notes", async () => {
    const logger = { info: vi.fn() };
    const coreRequestId = "79205b99-2122-4bf0-a90b-24d276cc88cf";
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/ogg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider(logger);

    await provider.synthesize({
      text: "PRIVATE_SYNTHETIC_TEXT",
      cfg: {} as never,
      providerConfig,
      target: "voice-note",
      requestId: coreRequestId,
      timeoutMs: 1_000,
    });

    const events = logger.info.mock.calls.map(([message]) => JSON.parse(message as string));
    expect(events.map((event) => event.phase)).toEqual(["start", "headers", "complete"]);
    const requestId = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(events.every((event) => event.requestId === requestId["X-OpenClaw-Request-Id"])).toBe(
      true,
    );
    expect(events.every((event) => event.requestId === coreRequestId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_SYNTHETIC_TEXT");
  });

  it("classifies a voice-note HTTP failure without logging the speech text", async () => {
    const logger = { info: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 408 })));
    const { provider, providerConfig } = configuredProvider(logger);

    await expect(
      provider.synthesize({
        text: "PRIVATE_SYNTHETIC_TEXT",
        cfg: {} as never,
        providerConfig,
        target: "voice-note",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("HTTP 408");

    const events = logger.info.mock.calls.map(([message]) => JSON.parse(message as string));
    expect(events.map((event) => event.phase)).toEqual(["start", "headers", "failed"]);
    expect(events.at(-1)).toMatchObject({ httpStatus: 408, failureClass: "http" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_SYNTHETIC_TEXT");
  });

  it("requests fixed-rate PCM for telephony", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([4, 5]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();

    await expect(
      provider.synthesizeTelephony?.({
        text: "Guten Tag",
        cfg: {} as never,
        providerConfig,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      audioBuffer: Buffer.from([4, 5]),
      outputFormat: "pcm",
      sampleRate: 24_000,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      response_format: "pcm",
      sample_rate: 24_000,
    });
  });

  it("decodes ordered framed PCM for streaming telephony", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(framedPcmStream([Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5, 6])]), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openclaw.pcm-stream",
          "x-openclaw-audio-sample-rate": "24000",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();

    const result = await provider.streamSynthesizeTelephony({
      text: "Guten Tag",
      providerConfig,
      timeoutMs: 1_000,
    });

    await expect(readStream(result.audioStream)).resolves.toEqual([
      Buffer.from([1, 2]),
      Buffer.from([3, 4, 5, 6]),
    ]);
    expect(result).toMatchObject({ outputFormat: "pcm", sampleRate: 24_000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8020/v1/audio/speech/stream");
    expect(JSON.parse(String(init.body))).toMatchObject({
      voice: "nova",
      response_format: "pcm",
      sample_rate: 24_000,
    });
  });

  it("rejects a telephony stream without a completion frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(Uint8Array.from([0, 0, 0, 2, 1, 2]), {
          status: 200,
          headers: {
            "content-type": "application/vnd.openclaw.pcm-stream",
            "x-openclaw-audio-sample-rate": "24000",
          },
        }),
      ),
    );
    const { provider, providerConfig } = configuredProvider();
    const result = await provider.streamSynthesizeTelephony({
      text: "Unvollständig",
      providerConfig,
      timeoutMs: 1_000,
    });

    await expect(readStream(result.audioStream)).rejects.toThrow("ended before completion");
  });

  it("cancels the upstream HTTP body when telephony playback is interrupted", async () => {
    const upstreamCancel = vi.fn();
    const firstFrame = Buffer.alloc(6);
    firstFrame.writeUInt32BE(2, 0);
    firstFrame.set([1, 2], 4);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstFrame);
      },
      cancel: upstreamCancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/vnd.openclaw.pcm-stream",
            "x-openclaw-audio-sample-rate": "24000",
          },
        }),
      ),
    );
    const { provider, providerConfig } = configuredProvider();
    const result = await provider.streamSynthesizeTelephony({
      text: "Unterbrechbar",
      providerConfig,
      timeoutMs: 1_000,
    });
    const reader = result.audioStream.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: Uint8Array.from([1, 2]),
    });
    await reader.cancel("barge-in");

    expect(upstreamCancel).toHaveBeenCalledWith("barge-in");
  });

  it("does not report remote endpoints as configured", () => {
    const provider = buildLocalMediaSpeechProvider();
    expect(
      provider.isConfigured({
        cfg: {} as never,
        providerConfig: { baseUrl: "http://192.168.1.50:8020/v1" },
        timeoutMs: 1_000,
      }),
    ).toBe(false);
  });

  it("maps explicit model and public voice ids to provider overrides", () => {
    const provider = buildLocalMediaSpeechProvider();
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: { modelId: "chatterbox", voiceId: "nova" },
      }),
    ).toEqual({ model: "chatterbox", voice: "nova" });
    expect(
      provider.resolveTalkOverrides?.({
        talkProviderConfig: {},
        params: { voiceId: "/private/reference.wav" },
      }),
    ).toEqual({});
  });

  it("discovers public voices from the host-leased local service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          object: "list",
          model: "chatterbox",
          default_voice: "example_member",
          data: [
            {
              id: "example_member",
              name: "example_member",
              locale: "de-DE",
              description: "Ruhige Stimme",
              reference_path: "/private/voice.wav",
            },
            { id: "nova", name: "Nova" },
          ],
        }),
      ),
    );
    const provider = buildLocalMediaSpeechProvider();
    await expect(
      provider.listVoices?.({
        providerConfig: { baseUrl: "http://127.0.0.1:8020/v1" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual([
      {
        id: "example_member",
        name: "example_member",
        locale: "de-DE",
        description: "Ruhige Stimme",
      },
      { id: "nova", name: "Nova" },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://127.0.0.1:8020/v1/voices",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("rejects oversized audio before buffering it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": String(65 * 1024 * 1024) },
        }),
      ),
    );
    const { provider, providerConfig } = configuredProvider();

    await expect(
      provider.synthesize({
        text: "oversized",
        cfg: {} as never,
        providerConfig,
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("exceeds the configured size limit");
  });

  it("rejects successful non-audio responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("unexpected", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    const { provider, providerConfig } = configuredProvider();

    await expect(
      provider.synthesize({
        text: "wrong response",
        cfg: {} as never,
        providerConfig,
        target: "audio-file",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("returned a non-audio response");
  });
});
