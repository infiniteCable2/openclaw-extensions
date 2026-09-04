import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  LOCAL_MEDIA_PROVIDER_ID,
} from "./constants.js";
import { requireLoopbackBaseUrl, resolveLoopbackBaseUrl } from "./local-url.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_AUDIO_RESPONSE_BYTES = 64 * 1024 * 1024;

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

function readConfiguredVoices(config: SpeechProviderConfig): string[] {
  const configured = Array.isArray(config.voices)
    ? config.voices
        .map((value) => readString(value))
        .filter((value): value is string => Boolean(value))
        .slice(0, 64)
    : [];
  const selected = readString(config.voice ?? config.voiceId) ?? DEFAULT_TTS_VOICE;
  return [...new Set([selected, ...configured])];
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
    isConfigured: ({ providerConfig }) => Boolean(resolveLoopbackBaseUrl(providerConfig.baseUrl)),
    listVoices: async ({ providerConfig }) =>
      readConfiguredVoices(providerConfig ?? {}).map((id) => ({ id, name: id })),
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
