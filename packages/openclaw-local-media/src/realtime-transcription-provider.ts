import {
  type OpenClawPluginApi,
  type RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_STT_MODEL, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { requireLoopbackBaseUrl } from "./local-url.js";

type AcquireLocalService = OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"];
type RealtimeTranscriptionProviderConfig = Record<string, unknown>;
type RealtimeTranscriptionSessionCreateRequest = Parameters<
  RealtimeTranscriptionProviderPlugin["createSession"]
>[0];
type RealtimeTranscriptionSession = ReturnType<
  RealtimeTranscriptionProviderPlugin["createSession"]
>;
type LocalRealtimeTranscriptionProvider = RealtimeTranscriptionProviderPlugin & {
  prepareSession(request: {
    providerConfig: RealtimeTranscriptionProviderConfig;
    signal?: AbortSignal;
  }): Promise<{ release(): void | Promise<void> } | undefined>;
};

type LocalRealtimeConfig = {
  baseUrl: string;
  model: string;
  language?: string;
  speechRmsThreshold: number;
  speechOnsetMs: number;
  silenceMs: number;
  preRollMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  requestTimeoutMs: number;
  maxQueuedUtterances: number;
};

const INPUT_SAMPLE_RATE = 8_000;
const INPUT_BYTES_PER_MS = INPUT_SAMPLE_RATE / 1_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function decodeMulawByte(encoded: number): number {
  const value = ~encoded & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  return sign ? -magnitude : magnitude;
}

function mulawToPcm(audio: Buffer): Buffer {
  const pcm = Buffer.allocUnsafe(audio.byteLength * 2);
  for (let index = 0; index < audio.byteLength; index += 1) {
    pcm.writeInt16LE(decodeMulawByte(audio[index] ?? 0), index * 2);
  }
  return pcm;
}

function calculateMulawRms(audio: Buffer): number {
  if (audio.byteLength === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (const encoded of audio) {
    const normalized = decodeMulawByte(encoded) / 32_768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / audio.byteLength);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function normalizeConfig(raw: RealtimeTranscriptionProviderConfig): LocalRealtimeConfig {
  return {
    baseUrl: requireLoopbackBaseUrl(
      optionalString(raw.baseUrl),
      "Local media realtime transcription",
    ),
    model: optionalString(raw.model) ?? DEFAULT_STT_MODEL,
    language: optionalString(raw.language),
    speechRmsThreshold: boundedNumber(raw.speechRmsThreshold, 0.015, 0.001, 0.5),
    speechOnsetMs: boundedNumber(raw.speechOnsetMs, 80, 20, 1_000),
    silenceMs: boundedNumber(raw.silenceMs, 700, 200, 5_000),
    preRollMs: boundedNumber(raw.preRollMs, 240, 0, 2_000),
    minSpeechMs: boundedNumber(raw.minSpeechMs, 160, 20, 3_000),
    maxUtteranceMs: boundedNumber(raw.maxUtteranceMs, 30_000, 1_000, 120_000),
    requestTimeoutMs: boundedNumber(raw.requestTimeoutMs, 300_000, 1_000, 600_000),
    maxQueuedUtterances: Math.floor(boundedNumber(raw.maxQueuedUtterances, 2, 1, 8)),
  };
}

function pcm16Wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(INPUT_SAMPLE_RATE, 24);
  header.writeUInt32LE(INPUT_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Local media realtime transcription response exceeded the size limit");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Local media realtime transcription response exceeded the size limit");
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function transcribeUtterance(params: {
  audio: Buffer;
  config: LocalRealtimeConfig;
  acquireLocalService: AcquireLocalService;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.config.requestTimeoutMs);
  const lease = await params.acquireLocalService(
    { providerId: LOCAL_MEDIA_PROVIDER_ID, baseUrl: params.config.baseUrl },
    controller.signal,
  );
  try {
    const form = new FormData();
    const wav = pcm16Wav(mulawToPcm(params.audio));
    form.set(
      "file",
      new Blob([Uint8Array.from(wav).buffer], { type: "audio/wav" }),
      "utterance.wav",
    );
    form.set("model", params.config.model);
    if (params.config.language) {
      form.set("language", params.config.language);
    }
    const endpoint = `${params.config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Local media realtime transcription failed with HTTP ${response.status}`);
    }
    const body = await readBoundedJson(response);
    if (
      !body ||
      typeof body !== "object" ||
      typeof (body as { text?: unknown }).text !== "string"
    ) {
      throw new Error("Local media realtime transcription returned an invalid response");
    }
    return (body as { text: string }).text.trim();
  } finally {
    clearTimeout(timer);
    lease?.release();
  }
}

function createSession(
  request: RealtimeTranscriptionSessionCreateRequest,
  acquireLocalService: AcquireLocalService,
): RealtimeTranscriptionSession {
  const config = normalizeConfig(request.providerConfig);
  let connected = false;
  let closed = false;
  let speaking = false;
  let onsetMs = 0;
  let quietMs = 0;
  let speechMs = 0;
  let preRollBytes = 0;
  let preRoll: Buffer[] = [];
  let utterance: Buffer[] = [];
  let utteranceBytes = 0;
  let queued = 0;
  let serial = Promise.resolve();

  const resetTurn = () => {
    speaking = false;
    onsetMs = 0;
    quietMs = 0;
    speechMs = 0;
    utterance = [];
    utteranceBytes = 0;
  };

  const fail = (error: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    connected = false;
    request.onError?.(
      error instanceof Error ? error : new Error("Local media transcription failed"),
    );
  };

  const enqueue = (audio: Buffer) => {
    if (queued >= config.maxQueuedUtterances) {
      fail(new Error("Local media realtime transcription queue limit exceeded"));
      return;
    }
    queued += 1;
    serial = serial
      .then(async () => {
        const text = await transcribeUtterance({ audio, config, acquireLocalService });
        if (!closed && text) {
          request.onTranscript?.(text);
        }
      })
      .catch(fail)
      .finally(() => {
        queued -= 1;
      });
  };

  const finishTurn = () => {
    const audio = Buffer.concat(utterance, utteranceBytes);
    const shouldTranscribe = speechMs >= config.minSpeechMs && audio.byteLength > 0;
    resetTurn();
    if (shouldTranscribe) {
      enqueue(audio);
    }
  };

  const retainPreRoll = (audio: Buffer) => {
    const limit = Math.floor(config.preRollMs * INPUT_BYTES_PER_MS);
    if (limit <= 0) {
      preRoll = [];
      preRollBytes = 0;
      return;
    }
    preRoll.push(audio);
    preRollBytes += audio.byteLength;
    while (preRollBytes > limit && preRoll.length > 1) {
      const removed = preRoll.shift();
      preRollBytes -= removed?.byteLength ?? 0;
    }
  };

  return {
    async connect() {
      if (closed) {
        throw new Error("Local media realtime transcription session is closed");
      }
      connected = true;
    },
    sendAudio(audio) {
      if (!connected || closed || audio.byteLength === 0) {
        return;
      }
      const chunk = Buffer.from(audio);
      const durationMs = chunk.byteLength / INPUT_BYTES_PER_MS;
      const loud = calculateMulawRms(chunk) >= config.speechRmsThreshold;

      if (!speaking) {
        retainPreRoll(chunk);
        onsetMs = loud ? onsetMs + durationMs : 0;
        if (onsetMs < config.speechOnsetMs) {
          return;
        }
        speaking = true;
        speechMs = onsetMs;
        utterance = preRoll;
        utteranceBytes = preRollBytes;
        preRoll = [];
        preRollBytes = 0;
        request.onSpeechStart?.();
      } else {
        utterance.push(chunk);
        utteranceBytes += chunk.byteLength;
        if (loud) {
          speechMs += durationMs;
        }
      }

      quietMs = loud ? 0 : quietMs + durationMs;
      const utteranceMs = utteranceBytes / INPUT_BYTES_PER_MS;
      if (quietMs >= config.silenceMs || utteranceMs >= config.maxUtteranceMs) {
        finishTurn();
      }
    },
    close() {
      closed = true;
      connected = false;
      resetTurn();
      preRoll = [];
      preRollBytes = 0;
    },
    isConnected() {
      return connected && !closed;
    },
  };
}

export function buildLocalRealtimeTranscriptionProvider(
  acquireLocalService: AcquireLocalService,
): LocalRealtimeTranscriptionProvider {
  return {
    id: LOCAL_MEDIA_PROVIDER_ID,
    label: "Local Media",
    defaultModel: DEFAULT_STT_MODEL,
    models: [DEFAULT_STT_MODEL],
    resolveConfig: ({ rawConfig }) => normalizeConfig(rawConfig),
    isConfigured: ({ providerConfig }) => {
      try {
        normalizeConfig(providerConfig);
        return true;
      } catch {
        return false;
      }
    },
    prepareSession: async ({ providerConfig, signal }) => {
      const config = normalizeConfig(providerConfig);
      return await acquireLocalService(
        { providerId: LOCAL_MEDIA_PROVIDER_ID, baseUrl: config.baseUrl },
        signal,
      );
    },
    createSession: (request) => createSession(request, acquireLocalService),
  };
}
