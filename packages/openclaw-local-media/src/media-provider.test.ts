import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalMediaUnderstandingProvider } from "./media-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function transcriptionRequest(baseUrl: string) {
  return {
    buffer: Buffer.from("test-audio"),
    fileName: "message.ogg",
    mime: "audio/ogg",
    apiKey: "",
    baseUrl,
    timeoutMs: 1_000,
  };
}

describe("local media understanding provider", () => {
  it("holds and releases the configured service lease around transcription", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ release });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "Hallo Welt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildLocalMediaUnderstandingProvider(acquire);
    await expect(
      provider.transcribeAudio?.(transcriptionRequest("http://127.0.0.1:8010/v1")),
    ).resolves.toEqual({ text: "Hallo Welt", model: "faster-whisper" });

    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "local-media",
        baseUrl: "http://127.0.0.1:8010/v1",
      }),
      undefined,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("marks only agent-directed speech for enhancement", async () => {
    const acquire = vi.fn().mockResolvedValue({ release: vi.fn() });
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ text: "verstanden" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = buildLocalMediaUnderstandingProvider(acquire);
    const request = transcriptionRequest("http://127.0.0.1:8010/v1");

    await provider.transcribeAudio?.({
      ...request,
      headers: { "X-OpenClaw-Speech-Input": "agent-speech" },
    });
    await provider.transcribeAudio?.({ ...request, speechInput: true });

    const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.has("x-openclaw-speech-input")).toBe(false);
    expect(secondHeaders.get("x-openclaw-speech-input")).toBe("agent-speech");
  });

  it("releases the service lease after an upstream failure", async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ release });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("service unavailable")));

    const provider = buildLocalMediaUnderstandingProvider(acquire);
    await expect(
      provider.transcribeAudio?.(transcriptionRequest("http://127.0.0.2:8010/v1")),
    ).rejects.toThrow("service unavailable");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects remote endpoints before acquiring a service lease", async () => {
    const acquire = vi.fn();
    const provider = buildLocalMediaUnderstandingProvider(acquire);

    await expect(
      provider.transcribeAudio?.(transcriptionRequest("https://example.test/v1")),
    ).rejects.toThrow("requires an explicit loopback HTTP(S) baseUrl");
    expect(acquire).not.toHaveBeenCalled();
  });
});
