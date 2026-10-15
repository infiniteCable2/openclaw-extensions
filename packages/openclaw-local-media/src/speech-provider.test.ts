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

function capabilityResponse() {
  return Response.json(
    {
      schema_version: 1,
      model: "kitten-tts-2",
      generation: "worker1",
      expression: { emotions: ["joyful"], vocalEvents: ["laugh"], emphasis: true, whisper: false },
    },
    { headers: { "X-OpenClaw-Service-Generation": "worker1" } },
  );
}

async function admitExpression(
  provider: ReturnType<typeof buildLocalMediaSpeechProvider>,
  providerConfig: Record<string, unknown>,
) {
  const localServiceAdmission = { generation: "worker1", signal: new AbortController().signal };
  await provider.prepareExpressionCapabilities?.({
    providerConfig,
    localServiceAdmission,
    timeoutMs: 1_000,
  });
  return localServiceAdmission;
}

describe("local media speech provider", () => {
  it.each([
    { phase: "queued", owner: "caller" },
    { phase: "running", owner: "caller" },
    { phase: "queued", owner: "worker" },
    { phase: "running", owner: "worker" },
  ])("cancels $phase buffered speech when its $owner lifetime ends", async ({ phase, owner }) => {
    const caller = new AbortController();
    const worker = new AbortController();
    const localServiceAdmission = { generation: "worker1", signal: worker.signal };
    let enter!: (request: RequestInit) => void;
    const entered = new Promise<RequestInit>((resolve) => {
      enter = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/capabilities")) return capabilityResponse();
      if (url.endsWith("/cancel")) return new Response(null, { status: 204 });
      const signal = init.signal;
      if (!signal) throw new Error("Expected bounded speech request signal");
      enter(init);
      if (phase === "queued") {
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          if (signal.aborted) reject(signal.reason);
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          if (signal.aborted) controller.error(signal.reason);
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "audio/ogg",
          "X-OpenClaw-Service-Generation": "worker1",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();
    const selected = { ...providerConfig, model: "kitten-tts-2" };
    await provider.prepareExpressionCapabilities?.({
      providerConfig: selected,
      localServiceAdmission,
      timeoutMs: 1_000,
    });
    const speech = provider.synthesize({
      cfg: {},
      text: "Hello.",
      providerConfig: selected,
      target: "voice-note",
      timeoutMs: 1_000,
      signal: caller.signal,
      localServiceAdmission,
      expression: { parts: [{ text: "Hello." }] },
    });
    const rejected = expect(speech).rejects.toThrow("Speech lifetime ended");
    const request = await entered;
    const headers = request.headers as Record<string, string>;
    expect(headers["X-OpenClaw-Service-Generation"]).toBe("worker1");
    (owner === "caller" ? caller : worker).abort(new Error("Speech lifetime ended"));
    await rejected;
    expect(request.signal?.aborted).toBe(true);
    expect((owner === "caller" ? worker : caller).signal.aborted).toBe(false);
    const cancelCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith("/cancel"));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]?.[0]).toBe(
      `http://127.0.0.1:8020/v1/requests/${headers["X-OpenClaw-Request-Id"]}/cancel`,
    );
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/audio/speech"))).toHaveLength(1);
  });

  it.each([
    {
      name: "persona voice ID overrides normalized base voice and stale model alias",
      providerConfig: {
        model: "kitten-tts-2",
        modelId: "chatterbox",
        voice: "default",
        speakerVoice: "default",
        voiceName: "default",
      },
      personaProviderConfig: { voiceId: "clone-a", speakerVoiceId: "clone-a" },
      providerOverrides: undefined,
      model: "kitten-tts-2",
      voice: "clone-a",
    },
    {
      name: "explicit overrides win over persona and base",
      providerConfig: { model: "chatterbox", voice: "default", speakerVoice: "default" },
      personaProviderConfig: { model: "chatterbox", voiceId: "clone-a", speakerVoiceId: "clone-a" },
      providerOverrides: {
        modelId: "kitten-tts-2",
        voiceId: "clone-b",
        speakerVoiceId: "clone-b",
        speed: 1.2,
      },
      model: "kitten-tts-2",
      voice: "clone-b",
    },
    {
      name: "explicit model and voice names win over persona IDs and stale override aliases",
      providerConfig: { model: "chatterbox", voice: "default" },
      personaProviderConfig: {
        modelId: "chatterbox",
        voiceId: "clone-a",
        speakerVoiceId: "clone-a",
      },
      providerOverrides: { model: "kitten-tts-2", modelId: "chatterbox", voice: "clone-c" },
      model: "kitten-tts-2",
      voice: "clone-c",
    },
    {
      name: "persona model ID wins over base model",
      providerConfig: { model: "chatterbox", modelId: "chatterbox", voice: "default" },
      personaProviderConfig: { modelId: "kitten-tts-2", voiceId: "clone-a" },
      providerOverrides: undefined,
      model: "kitten-tts-2",
      voice: "clone-a",
    },
    {
      name: "actual provider defaults are published",
      providerConfig: {},
      personaProviderConfig: undefined,
      providerOverrides: undefined,
      model: "chatterbox",
      voice: "default",
    },
  ])("prepares canonical selection without inference: $name", async (selection) => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith("/capabilities")
        ? capabilityResponse()
        : new Response(Uint8Array.of(1, 2), { headers: { "content-type": "audio/ogg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = buildLocalMediaSpeechProvider();
    const prepared = await provider.prepareSynthesis?.({
      cfg: {},
      text: "Hello.",
      target: "voice-note",
      timeoutMs: 1_000,
      providerConfig: { baseUrl: "http://127.0.0.1:8020/v1", ...selection.providerConfig },
      personaProviderConfig: selection.personaProviderConfig,
      providerOverrides: selection.providerOverrides,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepared?.text).toBeUndefined();
    const canonical = {
      model: selection.model,
      modelId: selection.model,
      speakerVoiceId: selection.voice,
      speakerVoice: selection.voice,
      voiceId: selection.voice,
      voiceName: selection.voice,
      voice: selection.voice,
    };
    expect(prepared?.providerConfig).toMatchObject(canonical);
    if (!prepared?.providerConfig) throw new Error("Expected prepared provider config");
    if (selection.providerOverrides) {
      expect(prepared.providerOverrides).toMatchObject({
        ...selection.providerOverrides,
        ...canonical,
      });
    }
    if (selection.model === "kitten-tts-2") {
      const localServiceAdmission = { generation: "worker1", signal: new AbortController().signal };
      await provider.prepareExpressionCapabilities?.({
        providerConfig: prepared.providerConfig,
        providerOverrides: prepared.providerOverrides,
        localServiceAdmission,
        timeoutMs: 1_000,
      });
      expect(
        provider.getExpressionCapabilities?.({
          providerConfig: prepared.providerConfig,
          providerOverrides: prepared.providerOverrides,
          localServiceAdmission,
        }),
      ).toMatchObject({ emotions: ["joyful"] });
    }
    await provider.synthesize({
      cfg: {},
      text: "Hello.",
      target: "voice-note",
      timeoutMs: 1_000,
      providerConfig: prepared.providerConfig,
      providerOverrides: prepared.providerOverrides,
    });
    const speechCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/audio/speech"));
    expect(JSON.parse(String(speechCall?.[1].body))).toMatchObject({
      model: selection.model,
      voice: selection.voice,
    });
  });

  it("advertises only actual capabilities for the admitted worker and selected model", async () => {
    const { provider, providerConfig } = configuredProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => capabilityResponse()),
    );
    expect(provider.getExpressionCapabilities?.({ providerConfig })).toBeUndefined();
    const selected = { ...providerConfig, model: "kitten-tts-2" };
    expect(provider.getExpressionCapabilities?.({ providerConfig: selected })).toBeUndefined();
    const localServiceAdmission = await admitExpression(provider, selected);
    const metadata = provider.getExpressionCapabilities?.({
      providerConfig: { ...providerConfig, model: "kitten-tts-2" },
      localServiceAdmission,
    });
    expect(metadata).toMatchObject({
      emotions: expect.arrayContaining(["joyful"]),
      whisper: false,
    });
    expect(metadata?.vocalEvents).toContain("laugh");
    expect(
      provider.getExpressionCapabilities?.({ providerConfig: { model: "unknown" } }),
    ).toBeUndefined();
    expect(provider.getExpressionCapabilities?.({ providerConfig: {} })).toBeUndefined();
    expect(
      provider.getExpressionCapabilities?.({
        providerConfig,
        providerOverrides: { modelId: " kitten-tts-2 " },
        localServiceAdmission,
      }),
    ).toEqual(metadata);
    expect(
      provider.getExpressionCapabilities?.({
        providerConfig: { model: "kitten-tts-2" },
        providerOverrides: { model: "chatterbox" },
      }),
    ).toBeUndefined();
  });

  it("forwards admitted speech-only expression with unchanged plain text for voice notes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(capabilityResponse())
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2]), {
          headers: { "content-type": "audio/ogg", "X-OpenClaw-Service-Generation": "worker1" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();
    const expression = {
      emotion: "joyful",
      parts: [{ text: "Hello " }, { event: "laugh" }, { text: "world." }],
    };
    const selected = { ...providerConfig, model: "kitten-tts-2", voice: "example_voice" };
    const localServiceAdmission = await admitExpression(provider, selected);
    await provider.synthesize({
      text: "Hello world.",
      cfg: {},
      providerConfig: selected,
      localServiceAdmission,
      expression,
      target: "voice-note",
      timeoutMs: 1_000,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(body).toEqual({
      input: "Hello world.",
      model: "kitten-tts-2",
      voice: "example_voice",
      response_format: "opus",
      expression,
    });
  });

  it("forwards the same expression for buffered and streamed telephony", async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith("/capabilities")
        ? capabilityResponse()
        : url.endsWith("/stream")
          ? new Response(framedPcmStream([Uint8Array.of(1, 2)]), {
              headers: {
                "content-type": "application/vnd.openclaw.pcm-stream",
                "x-openclaw-audio-sample-rate": "24000",
                "X-OpenClaw-Service-Generation": "worker1",
              },
            })
          : new Response(Uint8Array.of(1, 2), {
              headers: { "X-OpenClaw-Service-Generation": "worker1" },
            }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();
    const expression = {
      emotion: "joyful",
      parts: [{ text: "Hello.", emotion: "joyful", emphasis: true }],
    };
    const selected = { ...providerConfig, model: "kitten-tts-2" };
    const localServiceAdmission = await admitExpression(provider, selected);
    const request = {
      text: "Hello.",
      cfg: {},
      providerConfig: selected,
      localServiceAdmission,
      expression,
      timeoutMs: 1_000,
    };
    await provider.synthesizeTelephony?.(request);
    const streamed = await provider.streamSynthesizeTelephony(request);
    await readStream(streamed.audioStream);
    const bodies = fetchMock.mock.calls
      .filter(([url]) => !url.endsWith("/capabilities"))
      .map(([, init]) => JSON.parse(String(init.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({ input: "Hello.", expression, sample_rate: 24000 });
  });

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

  it("rejects worker replacement explicitly without resending the expressive utterance", async () => {
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) =>
      url.endsWith("/capabilities")
        ? capabilityResponse()
        : new Response(null, {
            status: 409,
            headers: { "X-OpenClaw-Service-Generation": "worker2" },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { provider, providerConfig } = configuredProvider();
    const selected = { ...providerConfig, model: "kitten-tts-2" };
    const localServiceAdmission = await admitExpression(provider, selected);
    await expect(
      provider.synthesize({
        text: "Hello.",
        cfg: {},
        target: "voice-note",
        providerConfig: selected,
        timeoutMs: 1_000,
        localServiceAdmission,
        expression: { parts: [{ text: "Hello." }] },
      }),
    ).rejects.toMatchObject({ name: "LocalServiceAdmissionError" });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/audio/speech"))).toHaveLength(1);
    expect(
      fetchMock.mock.calls.find(([url]) => url.endsWith("/audio/speech"))?.[1]?.headers,
    ).toMatchObject({ "X-OpenClaw-Service-Generation": "worker1" });
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
          default_voice: "example_voice_member",
          data: [
            {
              id: "example_voice_member",
              name: "Example member voice",
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
        id: "example_voice_member",
        name: "Example member voice",
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
