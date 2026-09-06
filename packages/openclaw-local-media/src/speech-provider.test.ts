import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalMediaSpeechProvider } from "./speech-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function configuredProvider() {
  const provider = buildLocalMediaSpeechProvider();
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
        text: "Hallo Steffen",
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
      input: "Hallo Steffen",
      model: "test-voice-model",
      voice: "nova",
      response_format: "opus",
    });
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
      sampleRate: 16_000,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      response_format: "pcm",
      sample_rate: 16_000,
    });
  });

  it("decodes ordered framed PCM for streaming telephony", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(framedPcmStream([Uint8Array.from([1, 2]), Uint8Array.from([3, 4, 5, 6])]), {
        status: 200,
        headers: {
          "content-type": "application/vnd.openclaw.pcm-stream",
          "x-openclaw-audio-sample-rate": "16000",
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
    expect(result).toMatchObject({ outputFormat: "pcm", sampleRate: 16_000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8020/v1/audio/speech/stream");
    expect(JSON.parse(String(init.body))).toMatchObject({
      voice: "nova",
      response_format: "pcm",
      sample_rate: 16_000,
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
            "x-openclaw-audio-sample-rate": "16000",
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
          default_voice: "astrid",
          data: [
            {
              id: "astrid",
              name: "Astrid",
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
        id: "astrid",
        name: "Astrid",
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
