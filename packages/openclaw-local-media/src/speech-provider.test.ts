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

  it("lists the configured default and allowlisted voices", async () => {
    const provider = buildLocalMediaSpeechProvider();
    await expect(
      provider.listVoices?.({
        providerConfig: {
          voice: "astrid",
          voices: ["astrid", "nova", "nova", "  fallback  ", ""],
        },
      }),
    ).resolves.toEqual([
      { id: "astrid", name: "astrid" },
      { id: "nova", name: "nova" },
      { id: "fallback", name: "fallback" },
    ]);
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
