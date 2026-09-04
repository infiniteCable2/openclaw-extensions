import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  LOCAL_MEDIA_PROVIDER_ID,
} from "./constants.js";
import { requireLoopbackBaseUrl, resolveLoopbackBaseUrl } from "./local-url.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_AUDIO_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_VOICE_CATALOG_BYTES = 64 * 1024;
const VOICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

type SpeechProviderConfig = Record<string, unknown>;
type SpeechProviderOverrides = Record<string, unknown>;

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
): { model: string; voice: string } {
  return {
    model:
      readString(overrides?.model ?? overrides?.modelId) ??
      readString(config.model ?? config.modelId) ??
      DEFAULT_TTS_MODEL,
    voice:
      readString(overrides?.voice ?? overrides?.voiceId) ??
      readString(config.voice ?? config.voiceId) ??
      DEFAULT_TTS_VOICE,
  };
}

async function requestSpeech(params: {
  text: string;
  providerConfig: SpeechProviderConfig;
  overrides?: SpeechProviderOverrides;
  responseFormat: "opus" | "wav" | "pcm";
  sampleRate?: number;
  timeoutMs: number;
}): Promise<Buffer> {
  const baseUrl = requireLoopbackBaseUrl(params.providerConfig.baseUrl, "Local media TTS");
  const selection = readSpeechSelection(params.providerConfig, params.overrides);
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: params.text,
      model: selection.model,
      voice: selection.voice,
      response_format: params.responseFormat,
      ...(params.sampleRate ? { sample_rate: params.sampleRate } : {}),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(params.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Local media TTS failed with HTTP ${response.status}`);
  }
  return await readBoundedAudioResponse(response);
}

async function readBoundedAudioResponse(response: Response): Promise<Buffer> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && !contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
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

export function buildLocalMediaSpeechProvider(): SpeechProviderPlugin {
  return {
    id: LOCAL_MEDIA_PROVIDER_ID,
    label: "Local media",
    autoSelectOrder: 10,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    defaultModel: DEFAULT_TTS_MODEL,
    models: [DEFAULT_TTS_MODEL],
    voices: [DEFAULT_TTS_VOICE],
    resolveConfig: ({ rawConfig }) => resolveProviderConfig(rawConfig),
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
      const voiceNote = req.target === "voice-note";
      const responseFormat = voiceNote ? "opus" : "wav";
      return {
        audioBuffer: await requestSpeech({
          text: req.text,
          providerConfig: req.providerConfig,
          overrides: req.providerOverrides,
          responseFormat,
          timeoutMs: req.timeoutMs,
        }),
        outputFormat: responseFormat,
        fileExtension: voiceNote ? ".ogg" : ".wav",
        voiceCompatible: voiceNote,
      };
    },
    async synthesizeTelephony(req) {
      const sampleRate = 16_000;
      return {
        audioBuffer: await requestSpeech({
          text: req.text,
          providerConfig: req.providerConfig,
          overrides: req.providerOverrides,
          responseFormat: "pcm",
          sampleRate,
          timeoutMs: req.timeoutMs,
        }),
        outputFormat: "pcm",
        sampleRate,
      };
    },
  };
}
