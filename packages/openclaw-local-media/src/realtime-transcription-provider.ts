import {
  type OpenClawPluginApi,
  type RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_STT_MODEL, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { requireLoopbackBaseUrl } from "./local-url.js";
import { readTranscriptionEvents } from "./transcription-events.js";

type AcquireLocalService = OpenClawPluginApi["runtime"]["llm"]["acquireLocalService"];
type DiagnosticLogger = Pick<OpenClawPluginApi["logger"], "info">;
type UtteranceOutcome =
  | "transcribed"
  | "partial"
  | "empty"
  | "too_short"
  | "queue_overflow"
  | "cancelled"
  | "timeout"
  | "failed";
type UtteranceTimings = {
  endpointAt: number;
  endpointSilenceWallMs: number;
  trailingSilenceAudioMs: number;
  utteranceAudioMs: number;
  queueWaitMs: number | null;
  acquireMs: number | null;
  httpMs: number | null;
  timedOut: boolean;
  reported: boolean;
};
type RealtimeTranscriptionProviderConfig = Record<string, unknown>;
type RealtimeTranscriptionSessionCreateRequest = Parameters<
  RealtimeTranscriptionProviderPlugin["createSession"]
>[0];
type RealtimeTranscriptionSession = ReturnType<
  RealtimeTranscriptionProviderPlugin["createSession"]
>;
type ProcessingState = Parameters<
  NonNullable<RealtimeTranscriptionSessionCreateRequest["onProcessing"]>
>[0]["state"];
type LocalRealtimeTranscriptionProvider = RealtimeTranscriptionProviderPlugin & {
  readonly transcriptGranularity: "utterance";
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

type TranscriptTurn = {
  text: string;
  generation: number;
  utteranceId?: string;
  speechConfirmed?: boolean;
  confirmationPublished?: boolean;
  minimumSpeechReached?: boolean;
  discarded?: boolean;
};

const INPUT_SAMPLE_RATE = 8_000;
const INPUT_BYTES_PER_MS = INPUT_SAMPLE_RATE / 1_000;
const ANALYSIS_FRAME_MS = 20;
const ANALYSIS_FRAME_BYTES = INPUT_BYTES_PER_MS * ANALYSIS_FRAME_MS;
const MAX_RESPONSE_BYTES = 256 * 1024;

function boundedAdd(value: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + increment);
}

function elapsedMs(start: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - start)));
}

function logDiagnostic(
  logger: DiagnosticLogger | undefined,
  event: "local_media_stt_utterance" | "local_media_stt_input_summary",
  fields: Record<string, string | number | null>,
): void {
  try {
    logger?.info(JSON.stringify({ event, ...fields }));
  } catch {
    // Diagnostics must not interrupt media delivery or lease cleanup.
  }
}

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
  signal: AbortSignal;
  timings: UtteranceTimings;
  onSpeechConfirmed?: () => void;
}): Promise<string> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const timer = setTimeout(() => {
    params.timings.timedOut = true;
    controller.abort();
  }, params.config.requestTimeoutMs);
  let lease: Awaited<ReturnType<AcquireLocalService>>;
  try {
    signal.throwIfAborted();
    const acquireStarted = performance.now();
    try {
      lease = await params.acquireLocalService(
        { providerId: LOCAL_MEDIA_PROVIDER_ID, baseUrl: params.config.baseUrl },
        signal,
      );
    } finally {
      params.timings.acquireMs = elapsedMs(acquireStarted);
    }
    signal.throwIfAborted();
    const form = new FormData();
    const wav = pcm16Wav(mulawToPcm(params.audio));
    form.set(
      "file",
      new Blob([Uint8Array.from(wav).buffer], { type: "audio/wav" }),
      "utterance.wav",
    );
    form.set("model", params.config.model);
    if (params.onSpeechConfirmed) {
      form.set("stream", "true");
    }
    if (params.config.language) {
      form.set("language", params.config.language);
    }
    const endpoint = `${params.config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
    const httpStarted = performance.now();
    let body: unknown;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        signal,
        ...(params.onSpeechConfirmed ? { headers: { accept: "text/event-stream" } } : {}),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Local media realtime transcription failed with HTTP ${response.status}`);
      }
      if (params.onSpeechConfirmed) {
        return await readTranscriptionEvents(response, signal, params.onSpeechConfirmed);
      }
      body = await readBoundedJson(response);
    } catch {
      // Network/parser failures can carry response text or local endpoint details.
      throw new Error("Local media realtime transcription request failed");
    } finally {
      params.timings.httpMs = elapsedMs(httpStarted);
    }
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
    await lease?.release();
  }
}

function createSession(
  request: RealtimeTranscriptionSessionCreateRequest,
  acquireLocalService: AcquireLocalService,
  logger?: DiagnosticLogger,
): RealtimeTranscriptionSession {
  const config = normalizeConfig(request.providerConfig);
  const sessionController = new AbortController();
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
  let inputFrame = Buffer.alloc(ANALYSIS_FRAME_BYTES);
  let inputFrameBytes = 0;
  let connectedAt: number | undefined;
  let lastInputAt: number | undefined;
  let lastLoudAt: number | undefined;
  let summaryReported = false;
  let consecutiveLoudMs = 0;
  let utteranceSequence = 0n;
  let speechGeneration = 0;
  let currentTurn: TranscriptTurn = { text: "", generation: 0 };
  const transcriptTurns = new Set<TranscriptTurn>();
  const pendingUtterances = new Set<string>();

  const notifyProcessing = (utteranceId: string, state: ProcessingState) => {
    try {
      request.onProcessing?.({ utteranceId, state });
    } catch {
      // Notifications must not prevent cancellation or release of media resources.
    }
  };
  const settleProcessing = (
    utteranceId: string,
    state: Extract<ProcessingState, "transcribed" | "empty" | "failed" | "cancelled">,
  ) => {
    if (pendingUtterances.delete(utteranceId)) notifyProcessing(utteranceId, state);
  };
  const cancelPending = () => {
    for (const id of pendingUtterances) settleProcessing(id, "cancelled");
    for (const turn of transcriptTurns) {
      turn.text = "";
      turn.discarded = true;
    }
    transcriptTurns.clear();
  };
  const confirmProcessing = (turn: TranscriptTurn) => {
    if (
      !closed &&
      !turn.discarded &&
      !speaking &&
      turn.generation === speechGeneration &&
      turn.utteranceId &&
      pendingUtterances.has(turn.utteranceId) &&
      turn.speechConfirmed &&
      !turn.confirmationPublished
    ) {
      turn.confirmationPublished = true;
      notifyProcessing(turn.utteranceId, "speech-confirmed");
    }
  };
  const input = {
    count: 0,
    audioMs: 0,
    maxPacketAudioMs: 0,
    maxInputGapMs: 0,
    frames: 0,
    loudFrames: 0,
    maxConsecutiveLoudMs: 0,
    speechStarts: 0,
    endpoints: 0,
    completed: 0,
    dropped: 0,
  };

  const captureTimings = (): UtteranceTimings => ({
    endpointAt: performance.now(),
    endpointSilenceWallMs: lastLoudAt === undefined ? 0 : elapsedMs(lastLoudAt),
    trailingSilenceAudioMs: quietMs,
    utteranceAudioMs: utteranceBytes / INPUT_BYTES_PER_MS,
    queueWaitMs: null,
    acquireMs: null,
    httpMs: null,
    timedOut: false,
    reported: false,
  });

  const reportUtterance = (timings: UtteranceTimings, outcome: UtteranceOutcome) => {
    if (timings.reported) {
      return;
    }
    timings.reported = true;
    if (outcome === "transcribed" || outcome === "partial" || outcome === "empty") {
      input.completed = boundedAdd(input.completed, 1);
    } else {
      input.dropped = boundedAdd(input.dropped, 1);
    }
    logDiagnostic(logger, "local_media_stt_utterance", {
      outcome,
      queueWaitMs: timings.queueWaitMs,
      acquireMs: timings.acquireMs,
      httpMs: timings.httpMs,
      endpointToTranscriptMs: outcome === "transcribed" ? elapsedMs(timings.endpointAt) : null,
      endpointSilenceWallMs: timings.endpointSilenceWallMs,
      trailingSilenceAudioMs: timings.trailingSilenceAudioMs,
      utteranceAudioMs: timings.utteranceAudioMs,
    });
  };

  const reportInput = () => {
    if (summaryReported) {
      return;
    }
    summaryReported = true;
    logDiagnostic(logger, "local_media_stt_input_summary", {
      ...input,
      elapsedMs: connectedAt === undefined ? 0 : elapsedMs(connectedAt),
      inputIdleMs: lastInputAt === undefined ? 0 : elapsedMs(lastInputAt),
      pendingUtterances: queued,
      partialFrameBytes: inputFrameBytes,
    });
  };

  const resetTurn = () => {
    speaking = false;
    onsetMs = 0;
    quietMs = 0;
    speechMs = 0;
    utterance = [];
    utteranceBytes = 0;
  };

  const discardInput = () => {
    if (speaking) {
      reportUtterance(captureTimings(), "cancelled");
    }
    reportInput();
    resetTurn();
    preRoll = [];
    preRollBytes = 0;
    inputFrame = Buffer.alloc(ANALYSIS_FRAME_BYTES);
    inputFrameBytes = 0;
  };

  const fail = (error: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    connected = false;
    sessionController.abort();
    cancelPending();
    discardInput();
    request.onError?.(
      error instanceof Error ? error : new Error("Local media transcription failed"),
    );
  };

  const enqueue = (
    audio: Buffer,
    timings: UtteranceTimings,
    silenceEndpoint: boolean,
    turn: TranscriptTurn,
  ) => {
    if (queued >= config.maxQueuedUtterances) {
      reportUtterance(timings, "queue_overflow");
      fail(new Error("Local media realtime transcription queue limit exceeded"));
      return;
    }
    // Audio caps bound STT work, not user turns. Only silence admits a final turn.
    const utteranceId = silenceEndpoint ? `utterance-${++utteranceSequence}` : undefined;
    if (utteranceId) {
      turn.utteranceId = utteranceId;
      pendingUtterances.add(utteranceId);
    }
    queued += 1;
    // Publish ownership at the endpoint, not after asynchronous queue/lease waits.
    if (utteranceId) {
      notifyProcessing(utteranceId, "started");
      confirmProcessing(turn);
    }
    serial = serial
      .then(async () => {
        if (closed) {
          reportUtterance(timings, "cancelled");
          return;
        }
        if (turn.discarded) {
          reportUtterance(timings, "too_short");
          return;
        }
        timings.queueWaitMs = elapsedMs(timings.endpointAt);
        try {
          const text = await transcribeUtterance({
            audio,
            config,
            acquireLocalService,
            signal: sessionController.signal,
            timings,
            ...(request.onProcessing
              ? {
                  onSpeechConfirmed: () => {
                    turn.speechConfirmed = true;
                    confirmProcessing(turn);
                  },
                }
              : {}),
          });
          if (closed) {
            reportUtterance(timings, "cancelled");
          } else if (turn.discarded) {
            reportUtterance(timings, "too_short");
          } else {
            if (text) {
              const combined = turn.text ? `${turn.text} ${text}` : text;
              if (Buffer.byteLength(combined, "utf8") > MAX_RESPONSE_BYTES) {
                throw new Error("Local media realtime transcription turn exceeded the text limit");
              }
              turn.text = combined;
            }
            if (utteranceId) {
              const finalText = turn.text;
              if (finalText) {
                if (request.onProcessing) request.onTranscript?.(finalText, { utteranceId });
                else request.onTranscript?.(finalText);
              }
              settleProcessing(utteranceId, finalText ? "transcribed" : "empty");
              reportUtterance(timings, finalText ? "transcribed" : "empty");
              turn.text = "";
              transcriptTurns.delete(turn);
            } else {
              // Cumulative partials never enter the host's final-turn dispatch path.
              if (text && turn.minimumSpeechReached) request.onPartial?.(turn.text);
              reportUtterance(timings, text ? "partial" : "empty");
            }
          }
        } catch (error) {
          if (turn.utteranceId) {
            settleProcessing(turn.utteranceId, closed ? "cancelled" : "failed");
          }
          reportUtterance(timings, closed ? "cancelled" : timings.timedOut ? "timeout" : "failed");
          throw error;
        }
      })
      .catch(fail)
      .finally(() => {
        queued -= 1;
      });
  };

  const finishTurn = () => {
    const timings = captureTimings();
    input.endpoints = boundedAdd(input.endpoints, 1);
    const audio = Buffer.concat(utterance, utteranceBytes);
    const silenceEndpoint = quietMs >= config.silenceMs;
    const turn = currentTurn;
    turn.minimumSpeechReached ||= speechMs >= config.minSpeechMs;
    const shouldTranscribe =
      (!silenceEndpoint || turn.minimumSpeechReached) && audio.byteLength > 0;
    if (silenceEndpoint) {
      resetTurn();
    } else {
      // Preserve onset and silence accounting across the bounded audio batch.
      utterance = [];
      utteranceBytes = 0;
    }
    if (shouldTranscribe) {
      enqueue(audio, timings, silenceEndpoint, turn);
    } else {
      reportUtterance(timings, "too_short");
      if (silenceEndpoint) {
        turn.discarded = true;
        turn.text = "";
        transcriptTurns.delete(turn);
      }
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

  const analyzeFrame = (chunk: Buffer) => {
    const durationMs = ANALYSIS_FRAME_MS;
    const loud = calculateMulawRms(chunk) >= config.speechRmsThreshold;
    input.frames = boundedAdd(input.frames, 1);
    consecutiveLoudMs = loud ? boundedAdd(consecutiveLoudMs, durationMs) : 0;
    input.maxConsecutiveLoudMs = Math.max(input.maxConsecutiveLoudMs, consecutiveLoudMs);
    if (loud) {
      input.loudFrames = boundedAdd(input.loudFrames, 1);
      lastLoudAt = performance.now();
    }

    if (!speaking) {
      retainPreRoll(chunk);
      onsetMs = loud ? onsetMs + durationMs : 0;
      if (onsetMs < config.speechOnsetMs) {
        return;
      }
      speaking = true;
      speechGeneration += 1;
      currentTurn = { text: "", generation: speechGeneration };
      transcriptTurns.add(currentTurn);
      input.speechStarts = boundedAdd(input.speechStarts, 1);
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
        speechMs = boundedAdd(speechMs, durationMs);
      }
    }

    quietMs = loud ? 0 : quietMs + durationMs;
    const utteranceMs = utteranceBytes / INPUT_BYTES_PER_MS;
    if (quietMs >= config.silenceMs || utteranceMs >= config.maxUtteranceMs) {
      finishTurn();
    }
  };

  return {
    async connect() {
      if (closed) {
        throw new Error("Local media realtime transcription session is closed");
      }
      connected = true;
      connectedAt ??= performance.now();
    },
    sendAudio(audio) {
      if (!connected || closed || audio.byteLength === 0) {
        return;
      }
      input.count = boundedAdd(input.count, 1);
      const packetAudioMs = audio.byteLength / INPUT_BYTES_PER_MS;
      input.audioMs = boundedAdd(input.audioMs, packetAudioMs);
      input.maxPacketAudioMs = Math.max(input.maxPacketAudioMs, packetAudioMs);
      if (lastInputAt !== undefined) {
        input.maxInputGapMs = Math.max(input.maxInputGapMs, elapsedMs(lastInputAt));
      }
      lastInputAt = performance.now();
      // Transport packet boundaries are not speech-analysis boundaries. Keep
      // at most one incomplete 20-ms frame, including for bytewise delivery.
      let offset = 0;
      while (offset < audio.byteLength && !closed) {
        const count = Math.min(ANALYSIS_FRAME_BYTES - inputFrameBytes, audio.byteLength - offset);
        inputFrame.set(audio.subarray(offset, offset + count), inputFrameBytes);
        inputFrameBytes += count;
        offset += count;
        if (inputFrameBytes === ANALYSIS_FRAME_BYTES) {
          const frame = inputFrame;
          inputFrame = Buffer.alloc(ANALYSIS_FRAME_BYTES);
          inputFrameBytes = 0;
          analyzeFrame(frame);
        }
      }
    },
    close() {
      closed = true;
      connected = false;
      sessionController.abort();
      cancelPending();
      discardInput();
    },
    isConnected() {
      return connected && !closed;
    },
  };
}

export function buildLocalRealtimeTranscriptionProvider(
  acquireLocalService: AcquireLocalService,
  logger?: DiagnosticLogger,
): LocalRealtimeTranscriptionProvider {
  return {
    id: LOCAL_MEDIA_PROVIDER_ID,
    label: "Local Media",
    transcriptGranularity: "utterance",
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
    createSession: (request) => createSession(request, acquireLocalService, logger),
  };
}
