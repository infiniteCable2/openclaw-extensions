import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSpeechCapabilitiesAdmission } from "./speech-expression.js";
import { buildLocalMediaSpeechProvider } from "./speech-provider.js";

afterEach(() => vi.unstubAllGlobals());
const baseUrl = "http://127.0.0.1:8020/v1";
const profile = {
  minChars: 0,
  targetWords: 32,
  maxWords: 45,
  maxChars: 400,
  pauses: { paragraph: 320, sentence: 180, clause: 80, fragment: 60 },
};
const expression = { emotions: ["joyful"], vocalEvents: ["laugh"], emphasis: true, whisper: false };
const segments = [
  { text: "Hello.", pauseMs: 180 },
  { text: "Goodbye.", pauseMs: 0 },
];
function capabilities(model = "chatterbox", extra: Record<string, unknown> = {}) {
  return Response.json(
    {
      schema_version: 1,
      model,
      generation: "worker1",
      expression: model === "kitten-tts-2" ? expression : null,
      segmentation: { schema_version: 1, profile, prepared_segments: true },
      ...extra,
    },
    { headers: { "X-OpenClaw-Service-Generation": "worker1" } },
  );
}
function fixture(model = "chatterbox") {
  const worker = new AbortController();
  const localServiceAdmission = { generation: "worker1", signal: worker.signal };
  const providerConfig = { baseUrl, model };
  return {
    worker,
    localServiceAdmission,
    providerConfig,
    context: { localServiceAdmission, providerConfig, timeoutMs: 1_000 },
    provider: buildLocalMediaSpeechProvider(),
    owner: createLocalSpeechCapabilitiesAdmission(),
  };
}

describe("worker-backed speech segmentation", () => {
  it.each(["chatterbox", "kitten-tts-2"])(
    "discovers %s profiles and expression in one admission fetch",
    async (model) => {
      const fetchMock = vi.fn(async () => capabilities(model));
      vi.stubGlobal("fetch", fetchMock);
      const { provider, context, worker } = fixture(model);
      expect(provider.getSegmentationProfile?.(context)).toBeUndefined();
      await Promise.all([
        provider.prepareSegmentationProfile?.(context),
        provider.prepareExpressionCapabilities?.(context),
      ]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(provider.getSegmentationProfile?.(context)).toEqual(profile);
      expect(provider.getExpressionCapabilities?.(context)).toEqual(
        model === "kitten-tts-2" ? expression : undefined,
      );
      expect(Object.isFrozen(provider.getSegmentationProfile?.(context)?.pauses)).toBe(true);
      worker.abort(new Error("worker retired"));
      expect(provider.getSegmentationProfile?.(context)).toBeUndefined();
      await expect(provider.prepareSegmentationProfile?.(context)).rejects.toThrow(
        "worker retired",
      );
    },
  );

  it.each([
    undefined,
    null,
    { schema_version: 2, profile, prepared_segments: true },
    { schema_version: 1, profile, prepared_segments: false },
    ...[
      { minChars: 401 },
      { minChars: 0.5 },
      { targetWords: 46 },
      { maxWords: 201 },
      { maxChars: 63 },
      { maxChars: 2001 },
      { pauses: { ...profile.pauses, sentence: -1 } },
      { pauses: { ...profile.pauses, sentence: 2001 } },
      { pauses: { sentence: 180, clause: 80, fragment: 60 } },
      { pauses: { ...profile.pauses, unknown: 0 } },
      { unknown: 0 },
    ].map((override) => ({
      schema_version: 1,
      profile: { ...profile, ...override },
      prepared_segments: true,
    })),
  ])("does not admit malformed or unsupported segmentation: %j", async (segmentation) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => capabilities("chatterbox", { segmentation })),
    );
    const { provider, context } = fixture();
    await expect(provider.prepareSegmentationProfile?.(context)).rejects.toThrow();
    expect(provider.getSegmentationProfile?.(context)).toBeUndefined();
  });

  it("rejects generation mismatch before exposing either capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => capabilities("kitten-tts-2", { generation: "worker2" })),
    );
    const { provider, context } = fixture("kitten-tts-2");
    await expect(provider.prepareSegmentationProfile?.(context)).rejects.toMatchObject({
      name: "LocalServiceAdmissionError",
    });
    expect(provider.getSegmentationProfile?.(context)).toBeUndefined();
    expect(provider.getExpressionCapabilities?.(context)).toBeUndefined();
  });

  it("does not trust a generation-free capabilities header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = capabilities();
        response.headers.delete("X-OpenClaw-Service-Generation");
        return response;
      }),
    );
    const { provider, context } = fixture();
    await expect(provider.prepareSegmentationProfile?.(context)).rejects.toMatchObject({
      name: "LocalServiceAdmissionError",
    });
    expect(provider.getSegmentationProfile?.(context)).toBeUndefined();
  });

  it("requires a native worker admission instead of legacy fallback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = fixture();
    await expect(
      provider.prepareSegmentationProfile?.({ providerConfig, timeoutMs: 1_000 }),
    ).rejects.toThrow("requires a worker admission");
    await expect(
      provider.synthesize({
        cfg: {},
        text: "Hello.Goodbye.",
        providerConfig,
        segments,
        target: "voice-note",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("no admitted service capabilities");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a cancelled waiter independent and retires both projections with the worker", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { owner, context, localServiceAdmission, worker } = fixture("kitten-tts-2");
    const caller = new AbortController();
    const cancelled = owner.prepare(
      { ...context, signal: caller.signal },
      baseUrl,
      "kitten-tts-2",
      true,
    );
    const retained = owner.prepare(context, baseUrl, "kitten-tts-2", true);
    caller.abort(new Error("caller closed"));
    await expect(cancelled).rejects.toThrow("caller closed");
    finish(capabilities("kitten-tts-2"));
    await retained;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(owner.getSegmentation(localServiceAdmission, baseUrl, "kitten-tts-2")).toEqual(profile);
    worker.abort();
    expect(owner.getSegmentation(localServiceAdmission, baseUrl, "kitten-tts-2")).toBeUndefined();
    expect(owner.get(localServiceAdmission, baseUrl, "kitten-tts-2")).toBeUndefined();
  });

  it("forwards one unchanged native plan through voice-note, buffered and streamed speech", async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith("/capabilities")) return capabilities();
      return new Response(
        url.endsWith("/stream") ? Uint8Array.of(0, 0, 0, 2, 1, 2, 0, 0, 0, 0) : Uint8Array.of(1, 2),
        {
          headers: {
            "content-type": url.endsWith("/stream")
              ? "application/vnd.openclaw.pcm-stream"
              : "audio/ogg",
            "x-openclaw-audio-sample-rate": "24000",
            "X-OpenClaw-Service-Generation": "worker1",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { provider, context } = fixture();
    await provider.prepareSegmentationProfile?.(context);
    const request = { ...context, cfg: {}, text: "Hello.Goodbye.", segments };
    await provider.synthesize({ ...request, target: "voice-note" });
    await provider.synthesizeTelephony?.(request);
    const streamed = await provider.streamSynthesizeTelephony(request);
    for await (const _frame of streamed.audioStream) {
      /* consume ordered frames */
    }
    const speechCalls = fetchMock.mock.calls.filter(([url]) => !url.endsWith("/capabilities"));
    expect(speechCalls).toHaveLength(3);
    for (const [, init] of speechCalls) {
      expect(JSON.parse(String(init.body))).toMatchObject({
        input: request.text,
        segmentation: { schema_version: 1, segments },
      });
      expect(init.headers).toMatchObject({ "X-OpenClaw-Service-Generation": "worker1" });
      expect(JSON.parse(String(init.body)).segmentation).not.toHaveProperty("profile");
    }
  });

  it("rejects stale-generation plain segmented synthesis without retry", async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith("/capabilities")
        ? capabilities()
        : new Response(null, {
            status: 409,
            headers: { "X-OpenClaw-Service-Generation": "worker2" },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, context } = fixture();
    await provider.prepareSegmentationProfile?.(context);
    await expect(
      provider.synthesize({
        ...context,
        cfg: {},
        text: "Hello.Goodbye.",
        segments,
        target: "voice-note",
      }),
    ).rejects.toMatchObject({ name: "LocalServiceAdmissionError" });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/audio/speech"))).toHaveLength(1);
  });

  it.each(["caller", "worker"])(
    "cancels plain prepared synthesis when the %s lifetime ends",
    async (owner) => {
      const caller = new AbortController();
      const { provider, context, worker } = fixture();
      let enter!: (request: RequestInit) => void;
      const entered = new Promise<RequestInit>((resolve) => {
        enter = resolve;
      });
      const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/capabilities")) return capabilities();
        if (url.endsWith("/cancel")) return new Response(null, { status: 204 });
        enter(init);
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) throw new Error("Expected bounded prepared synthesis signal");
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      await provider.prepareSegmentationProfile?.(context);
      const pending = provider.synthesize({
        ...context,
        cfg: {},
        text: "Hello.Goodbye.",
        segments,
        target: "voice-note",
        signal: caller.signal,
      });
      const rejected = expect(pending).rejects.toThrow("prepared speech ended");
      const request = await entered;
      (owner === "caller" ? caller : worker).abort(new Error("prepared speech ended"));
      await rejected;
      expect(request.signal?.aborted).toBe(true);
      expect((owner === "caller" ? worker : caller).signal.aborted).toBe(false);
      expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/cancel"))).toHaveLength(1);
    },
  );
});
