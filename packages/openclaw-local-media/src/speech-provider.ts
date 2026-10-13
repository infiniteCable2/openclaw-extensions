import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { requireLoopbackBaseUrl, resolveLoopbackBaseUrl } from "./local-url.js";
import { createMediaRequestLifecycle } from "./request-lifecycle.js";
import {
  createLocalSpeechCapabilitiesAdmission,
  KITTEN_TTS2_MODEL_ID,
} from "./speech-expression.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_AUDIO_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_VOICE_CATALOG_BYTES = 64 * 1024;
const VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type SpeechProviderConfig = Record<string, unknown>;
type SpeechProviderOverrides = Record<string, unknown>;
type SpeechExpression = NonNullable<
  Parameters<SpeechProviderPlugin["synthesize"]>[0]["expression"]
>;
type SpeechSegments = NonNullable<Parameters<SpeechProviderPlugin["synthesize"]>[0]["segments"]>;
type LocalServiceAdmission = Parameters<
  SpeechProviderPlugin["synthesize"]
>[0]["localServiceAdmission"];
type LocalMediaSpeechProvider = SpeechProviderPlugin & {
  streamSynthesizeTelephony(req: {
    text: string;
    providerConfig: SpeechProviderConfig;
    providerOverrides?: SpeechProviderOverrides;
    expression?: SpeechExpression;
    segments?: SpeechSegments;
    timeoutMs: number;
    signal?: AbortSignal;
    localServiceAdmission?: LocalServiceAdmission;
  }): Promise<{
    audioStream: ReadableStream<Uint8Array>;
    outputFormat: string;
    sampleRate: number;
  }>;
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveProviderConfig(rawConfig: Record<string, unknown>): SpeechProviderConfig {
  const providers = asObject(rawConfig.providers);
  return asObject(providers?.[LOCAL_MEDIA_PROVIDER_ID]) ?? {};
}

function readSpeechSelection(
  config: SpeechProviderConfig,
  overrides?: SpeechProviderOverrides,
  persona?: SpeechProviderConfig,
): { model: string; voice: string } {
  let model: string | undefined;
  let voice: string | undefined;
  // Native speaker compatibility normalizes each authored layer separately.
  // Choose a winner before merging; aliases left in another layer cannot win.
  for (const layer of [overrides, persona, config]) {
    if (!layer) continue;
    model ??= readString(layer.model) ?? readString(layer.modelId);
    voice ??=
      readString(layer.speakerVoiceId) ??
      readString(layer.speakerVoice) ??
      readString(layer.voiceId) ??
      readString(layer.voiceName) ??
      readString(layer.voice);
  }
  return { model: model ?? DEFAULT_TTS_MODEL, voice: voice ?? DEFAULT_TTS_VOICE };
}

async function requestSpeech(params: {
  text: string;
  providerConfig: SpeechProviderConfig;
  overrides?: SpeechProviderOverrides;
  expression?: SpeechExpression;
  segments?: SpeechSegments;
  responseFormat: "opus" | "wav" | "pcm";
  sampleRate?: number;
  timeoutMs: number;
  signal?: AbortSignal;
  localServiceAdmission?: LocalServiceAdmission;
}): Promise<Buffer> {
  const baseUrl = requireLoopbackBaseUrl(params.providerConfig.baseUrl, "Local media TTS");
  const selection = readSpeechSelection(params.providerConfig, params.overrides);
  const job = createMediaRequestLifecycle({
    baseUrl,
    timeoutMs: params.timeoutMs,
    signal:
      (params.expression || params.segments) && params.localServiceAdmission
        ? AbortSignal.any([
            params.localServiceAdmission.signal,
            ...(params.signal ? [params.signal] : []),
          ])
        : params.signal,
  });
  let response: Response | undefined;
  try {
    job.signal.throwIfAborted();
    response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...job.headers,
        ...((params.expression || params.segments) && params.localServiceAdmission
          ? { "X-OpenClaw-Service-Generation": params.localServiceAdmission.generation }
          : {}),
      },
      body: JSON.stringify({
        input: params.text,
        model: selection.model,
        voice: selection.voice,
        response_format: params.responseFormat,
        ...(params.sampleRate ? { sample_rate: params.sampleRate } : {}),
        ...(params.expression ? { expression: params.expression } : {}),
        ...(params.segments
          ? { segmentation: { schema_version: 1, segments: params.segments } }
          : {}),
      }),
      redirect: "error",
      signal: job.signal,
    });
    assertPreparedResponse(
      response,
      Boolean(params.expression || params.segments),
      params.localServiceAdmission,
    );
    if (!response.ok) {
      throw new Error(`Local media TTS failed with HTTP ${response.status}`);
    }
    const audio = await readBoundedAudioResponse(response);
    job.signal.throwIfAborted();
    return audio;
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    await job.cancel();
    throw error;
  } finally {
    job.finish();
  }
}

async function requestSpeechStream(params: {
  text: string;
  providerConfig: SpeechProviderConfig;
  overrides?: SpeechProviderOverrides;
  expression?: SpeechExpression;
  segments?: SpeechSegments;
  sampleRate: number;
  timeoutMs: number;
  signal?: AbortSignal;
  localServiceAdmission?: LocalServiceAdmission;
}): Promise<ReadableStream<Uint8Array>> {
  const baseUrl = requireLoopbackBaseUrl(params.providerConfig.baseUrl, "Local media TTS");
  const selection = readSpeechSelection(params.providerConfig, params.overrides);
  const job = createMediaRequestLifecycle({
    baseUrl,
    timeoutMs: params.timeoutMs,
    signal:
      (params.expression || params.segments) && params.localServiceAdmission
        ? AbortSignal.any([
            params.localServiceAdmission.signal,
            ...(params.signal ? [params.signal] : []),
          ])
        : params.signal,
  });
  let response: Response | undefined;
  try {
    job.signal.throwIfAborted();
    response = await fetch(`${baseUrl}/audio/speech/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...job.headers,
        ...((params.expression || params.segments) && params.localServiceAdmission
          ? { "X-OpenClaw-Service-Generation": params.localServiceAdmission.generation }
          : {}),
      },
      body: JSON.stringify({
        input: params.text,
        model: selection.model,
        voice: selection.voice,
        response_format: "pcm",
        sample_rate: params.sampleRate,
        ...(params.expression ? { expression: params.expression } : {}),
        ...(params.segments
          ? { segmentation: { schema_version: 1, segments: params.segments } }
          : {}),
      }),
      redirect: "error",
      signal: job.signal,
    });
    assertPreparedResponse(
      response,
      Boolean(params.expression || params.segments),
      params.localServiceAdmission,
    );
    if (!response.ok) {
      throw new Error(`Local media streaming TTS failed with HTTP ${response.status}`);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/vnd.openclaw.pcm-stream") {
      throw new Error("Local media streaming TTS returned an invalid content type");
    }
    if (Number(response.headers.get("x-openclaw-audio-sample-rate")) !== params.sampleRate) {
      throw new Error("Local media streaming TTS returned an unexpected sample rate");
    }
    if (!response.body) {
      throw new Error("Local media streaming TTS returned an empty response");
    }

    const reader = response.body.getReader();
    let buffered = Buffer.alloc(0);
    let totalLength = 0;
    let complete = false;
    let stopped = false;
    let cleanupPromise: Promise<void> | undefined;
    let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abortOutput = () => {
      if (stopped) return;
      // Erroring the output also drops a frame already queued by stream
      // prefetch; stopping fetch alone cannot invalidate that local buffer.
      outputController?.error(
        job.signal.reason ?? new Error("Local media streaming TTS cancelled"),
      );
      void cleanup(true, job.signal.reason);
    };
    const cleanup = (cancelJob: boolean, reason?: unknown): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      stopped = true;
      job.signal.removeEventListener("abort", abortOutput);
      buffered = Buffer.alloc(0);
      // Stop consumption immediately, before the best-effort cancellation
      // request waits for its independent HTTP deadline.
      const cancelReader = reader
        .cancel(reason)
        .catch(() => undefined)
        .then(() => {
          reader.releaseLock();
        });
      const cancelService = cancelJob ? job.cancel() : Promise.resolve();
      job.finish();
      cleanupPromise = Promise.all([cancelReader, cancelService]).then(() => undefined);
      return cleanupPromise;
    };
    const readMore = async () => {
      job.signal.throwIfAborted();
      const next = await reader.read();
      if (stopped) throw new Error("Local media streaming TTS closed");
      if (next.done) {
        throw new Error("Local media streaming TTS response ended before completion");
      }
      buffered = Buffer.concat([buffered, Buffer.from(next.value)]);
    };
    const readFrame = async (): Promise<Uint8Array | undefined> => {
      while (buffered.byteLength < 4) {
        await readMore();
      }
      const frameLength = buffered.readUInt32BE(0);
      if (frameLength === 0) {
        buffered = buffered.subarray(4);
        complete = true;
        return undefined;
      }
      if (frameLength > MAX_AUDIO_RESPONSE_BYTES || frameLength % 2 !== 0) {
        throw new Error("Local media streaming TTS returned an invalid frame");
      }
      while (buffered.byteLength < 4 + frameLength) {
        await readMore();
      }
      const frame = buffered.subarray(4, 4 + frameLength);
      buffered = buffered.subarray(4 + frameLength);
      totalLength += frame.byteLength;
      if (totalLength > MAX_AUDIO_RESPONSE_BYTES) {
        throw new Error("Local media streaming TTS response exceeds the configured size limit");
      }
      return Uint8Array.from(frame);
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
        job.signal.addEventListener("abort", abortOutput, { once: true });
        if (job.signal.aborted) abortOutput();
      },
      async pull(controller) {
        if (stopped) return;
        try {
          job.signal.throwIfAborted();
          const frame = await readFrame();
          if (stopped) return;
          job.signal.throwIfAborted();
          if (frame) {
            controller.enqueue(frame);
            return;
          }
          if (!complete || totalLength === 0 || buffered.byteLength !== 0) {
            throw new Error("Local media streaming TTS returned an incomplete response");
          }
          controller.close();
          await cleanup(false);
        } catch (error) {
          if (!stopped) controller.error(error);
          await cleanup(true, error);
        }
      },
      async cancel(reason) {
        await cleanup(true, reason);
      },
    });
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    await job.cancel();
    job.finish();
    throw error;
  }
}

function assertPreparedResponse(
  response: Response,
  prepared: boolean,
  admission?: LocalServiceAdmission,
): void {
  if (
    prepared &&
    (response.status === 409 ||
      response.headers.get("x-openclaw-service-generation") !== admission?.generation)
  ) {
    const error = new Error("Local media speech worker generation changed; prepare speech again");
    error.name = "LocalServiceAdmissionError";
    throw error;
  }
}

async function readBoundedAudioResponse(response: Response): Promise<Buffer> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType &&
    !contentType.startsWith("audio/") &&
    contentType !== "application/octet-stream"
  ) {
    throw new Error("Local media TTS returned a non-audio response");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_RESPONSE_BYTES) {
    throw new Error("Local media TTS response exceeds the configured size limit");
  }
  if (!response.body) {
    throw new Error("Local media TTS returned an empty response");
  }

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalLength += value.byteLength;
      if (totalLength > MAX_AUDIO_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Local media TTS response exceeds the configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalLength === 0) {
    throw new Error("Local media TTS returned an empty response");
  }
  return Buffer.concat(chunks, totalLength);
}

async function readBoundedVoiceCatalog(response: Response): Promise<
  Array<{
    id: string;
    name: string;
    locale?: string;
    description?: string;
  }>
> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Local media TTS returned a non-JSON voice catalog");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_CATALOG_BYTES) {
    throw new Error("Local media TTS voice catalog exceeds its size limit");
  }
  if (!response.body) {
    throw new Error("Local media TTS returned an empty voice catalog");
  }
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalLength += value.byteLength;
      if (totalLength > MAX_VOICE_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error("Local media TTS voice catalog exceeds its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, totalLength).toString("utf8"));
  } catch {
    throw new Error("Local media TTS returned an invalid voice catalog");
  }
  const data = asObject(body)?.data;
  if (!Array.isArray(data) || data.length < 1 || data.length > 64) {
    throw new Error("Local media TTS returned an invalid voice catalog");
  }
  const seen = new Set<string>();
  return data.map((raw) => {
    const voice = asObject(raw);
    const id = readString(voice?.id);
    const name = readString(voice?.name);
    if (!id || !name || !VOICE_ID_PATTERN.test(id) || seen.has(id)) {
      throw new Error("Local media TTS returned an invalid voice catalog");
    }
    seen.add(id);
    const locale = readString(voice?.locale);
    const description = readString(voice?.description);
    return {
      id,
      name,
      ...(locale ? { locale } : {}),
      ...(description ? { description } : {}),
    };
  });
}

export function buildLocalMediaSpeechProvider(): LocalMediaSpeechProvider {
  const capabilitiesAdmission = createLocalSpeechCapabilitiesAdmission();
  const requireSpeechAdmission = (request: {
    expression?: SpeechExpression;
    segments?: SpeechSegments;
    providerConfig: SpeechProviderConfig;
    providerOverrides?: SpeechProviderOverrides;
    localServiceAdmission?: LocalServiceAdmission;
  }) => {
    if (!request.expression && !request.segments) return;
    request.localServiceAdmission?.signal.throwIfAborted();
    const baseUrl = requireLoopbackBaseUrl(request.providerConfig.baseUrl, "Local media TTS");
    const model = readSpeechSelection(request.providerConfig, request.providerOverrides).model;
    if (
      request.expression &&
      !capabilitiesAdmission.get(request.localServiceAdmission, baseUrl, model)
    ) {
      throw new Error("Local media speech expression has no admitted service capabilities");
    }
    if (
      request.segments &&
      !capabilitiesAdmission.getSegmentation(request.localServiceAdmission, baseUrl, model)
    )
      throw new Error("Local media speech segmentation has no admitted service capabilities");
  };
  return {
    id: LOCAL_MEDIA_PROVIDER_ID,
    label: "Local media",
    autoSelectOrder: 10,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultModel: DEFAULT_TTS_MODEL,
    models: [DEFAULT_TTS_MODEL, KITTEN_TTS2_MODEL_ID],
    voices: [DEFAULT_TTS_VOICE],
    resolveConfig: ({ rawConfig }) => resolveProviderConfig(rawConfig),
    prepareSynthesis: ({ providerConfig, providerOverrides, personaProviderConfig }) => {
      const selection = readSpeechSelection(
        providerConfig,
        providerOverrides,
        personaProviderConfig,
      );
      // This provider's voice names and IDs are aliases for the same public wire
      // identifier. Publish one exact winner, including defaults, to native facts.
      const canonical = {
        model: selection.model,
        modelId: selection.model,
        speakerVoiceId: selection.voice,
        speakerVoice: selection.voice,
        voiceId: selection.voice,
        voiceName: selection.voice,
        voice: selection.voice,
      };
      return {
        providerConfig: { ...providerConfig, ...canonical },
        ...(providerOverrides ? { providerOverrides: { ...providerOverrides, ...canonical } } : {}),
      };
    },
    prepareExpressionCapabilities: (context) =>
      capabilitiesAdmission.prepare(
        context,
        requireLoopbackBaseUrl(context.providerConfig.baseUrl, "Local media TTS"),
        readSpeechSelection(context.providerConfig, context.providerOverrides).model,
      ),
    getExpressionCapabilities: ({ providerConfig, providerOverrides, localServiceAdmission }) => {
      const baseUrl = resolveLoopbackBaseUrl(providerConfig.baseUrl);
      return baseUrl
        ? capabilitiesAdmission.get(
            localServiceAdmission,
            baseUrl,
            readSpeechSelection(providerConfig, providerOverrides).model,
          )
        : undefined;
    },
    prepareSegmentationProfile: (context) =>
      capabilitiesAdmission.prepare(
        context,
        requireLoopbackBaseUrl(context.providerConfig.baseUrl, "Local media TTS"),
        readSpeechSelection(context.providerConfig, context.providerOverrides).model,
        true,
      ),
    getSegmentationProfile: ({ providerConfig, providerOverrides, localServiceAdmission }) => {
      const baseUrl = resolveLoopbackBaseUrl(providerConfig.baseUrl);
      return baseUrl
        ? capabilitiesAdmission.getSegmentation(
            localServiceAdmission,
            baseUrl,
            readSpeechSelection(providerConfig, providerOverrides).model,
          )
        : undefined;
    },
    resolveTalkOverrides: ({ params }) => {
      const model = readString(params.modelId);
      const voice = readString(params.voiceId);
      return {
        ...(model ? { model } : {}),
        ...(voice && VOICE_ID_PATTERN.test(voice) ? { voice } : {}),
      };
    },
    isConfigured: ({ providerConfig }) => Boolean(resolveLoopbackBaseUrl(providerConfig.baseUrl)),
    async listVoices({ providerConfig, timeoutMs }) {
      const config = providerConfig ?? {};
      const baseUrl = requireLoopbackBaseUrl(config.baseUrl, "Local media TTS");
      const signal = AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
      const response = await fetch(`${baseUrl}/voices`, {
        method: "GET",
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        throw new Error(`Local media TTS voice catalog failed with HTTP ${response.status}`);
      }
      return await readBoundedVoiceCatalog(response);
    },
    async synthesize(req) {
      requireSpeechAdmission(req);
      const voiceNote = req.target === "voice-note";
      const responseFormat = voiceNote ? "opus" : "wav";
      return {
        audioBuffer: await requestSpeech({
          text: req.text,
          providerConfig: req.providerConfig,
          overrides: req.providerOverrides,
          expression: req.expression,
          segments: req.segments,
          responseFormat,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          localServiceAdmission: req.localServiceAdmission,
        }),
        outputFormat: responseFormat,
        fileExtension: voiceNote ? ".ogg" : ".wav",
        voiceCompatible: voiceNote,
      };
    },
    async synthesizeTelephony(req) {
      requireSpeechAdmission(req);
      // Preserve the local backend's speech bandwidth. The host already owns
      // conversion to a transport's 8/16/24 kHz format from result.sampleRate.
      const sampleRate = 24_000;
      return {
        audioBuffer: await requestSpeech({
          text: req.text,
          providerConfig: req.providerConfig,
          overrides: req.providerOverrides,
          expression: req.expression,
          segments: req.segments,
          responseFormat: "pcm",
          sampleRate,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          localServiceAdmission: req.localServiceAdmission,
        }),
        outputFormat: "pcm",
        sampleRate,
      };
    },
    async streamSynthesizeTelephony(req) {
      requireSpeechAdmission(req);
      const sampleRate = 24_000;
      return {
        audioStream: await requestSpeechStream({
          text: req.text,
          providerConfig: req.providerConfig,
          overrides: req.providerOverrides,
          expression: req.expression,
          segments: req.segments,
          sampleRate,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
          localServiceAdmission: req.localServiceAdmission,
        }),
        outputFormat: "pcm",
        sampleRate,
      };
    },
  };
}
