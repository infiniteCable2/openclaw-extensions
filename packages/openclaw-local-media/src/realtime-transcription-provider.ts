import { randomUUID } from "node:crypto";
import {
  type OpenClawPluginApi,
  type RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_STT_MODEL, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { createLiveSpeechDiagnostics } from "./live-speech-diagnostics.js";
import {
  createLiveSpeechGate,
  type LiveSpeechEvidence,
  type SpeechObservation,
} from "./live-speech-gate.js";
import { requireLoopbackBaseUrl } from "./local-url.js";
import { createLiveSpeechProcessor } from "./live-speech-processor.js";
import { createMediaRequestLifecycle } from "./request-lifecycle.js";
import { readTranscriptionEvents, type TranscriptionResult } from "./transcription-events.js";

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
  sectionOrdinal: number;
  utteranceOrdinal: number;
  requestId: string | null;
  endpointAt: number;
  endpointSilenceWallMs: number;
  trailingSilenceAudioMs: number;
  utteranceAudioMs: number;
  queueWaitMs: number | null;
  acquireMs: number | null;
  httpMs: number | null;
  timedOut: boolean;
  reported: boolean;
  enhancedRms: number | null;
  originalRms: number | null;
  originalPeak: number | null;
  meanSpeechProbability: number | null;
  highProbabilityFrames: number;
  maxGainDb: number | null;
  vadSpeechDurationMs: number | null;
  decoderSegmentCount: number | null;
  recognitionSignals: Record<string, number>;
  emptyStage: "vad" | "decoder" | "unknown" | null;
};
type RealtimeTranscriptionProviderConfig = Record<string, unknown>;
type RealtimeTranscriptionSessionCreateRequest = Parameters<
  RealtimeTranscriptionProviderPlugin["createSession"]
>[0] & {
  // The linked OpenClaw SDK declarations may lag local source until its build.
  onSpeechActivity?: (event: {
    utteranceId: string;
    state: "candidate" | "sustained" | "rejected";
  }) => void;
};
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
  speechProbabilityThreshold: number;
  speechNoiseMarginDb: number;
  speechOnsetMs: number;
  silenceMs: number;
  preRollMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  requestTimeoutMs: number;
  maxQueuedUtterances: number;
  speechProcessorPython?: string;
};

type TranscriptTurn = {
  controller: AbortController;
  text: string;
  generation: number;
  trustedSpeechRmsSum: number;
  trustedSpeechFrames: number;
  speechObservation?: SpeechObservation;
  utteranceId?: string;
  speechConfirmed?: boolean;
  confirmationPublished?: boolean;
  minimumSpeechReached?: boolean;
  activitySustained?: boolean;
  discarded?: boolean;
};

const ANALYSIS_FRAME_MS = 20;
const MAX_RESPONSE_BYTES = 256 * 1024;
class TranscriptionBusyError extends Error {}

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

function calculatePcmRms(audio: Buffer): number {
  if (audio.byteLength === 0) return 0;
  let squares = 0;
  for (let offset = 0; offset < audio.byteLength; offset += 2) {
    const value = audio.readInt16LE(offset) / 32_768;
    squares += value * value;
  }
  return Math.sqrt(squares / (audio.byteLength / 2));
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
    speechProbabilityThreshold: boundedNumber(raw.speechProbabilityThreshold, 0.6, 0.1, 0.95),
    speechNoiseMarginDb: boundedNumber(raw.speechNoiseMarginDb, 3.5, 0, 12),
    speechOnsetMs: boundedNumber(raw.speechOnsetMs, 80, 20, 1_000),
    silenceMs: boundedNumber(raw.silenceMs, 700, 200, 5_000),
    preRollMs: boundedNumber(raw.preRollMs, 240, 0, 2_000),
    minSpeechMs: boundedNumber(raw.minSpeechMs, 160, 20, 3_000),
    maxUtteranceMs: boundedNumber(raw.maxUtteranceMs, 30_000, 1_000, 120_000),
    requestTimeoutMs: boundedNumber(raw.requestTimeoutMs, 300_000, 1_000, 600_000),
    maxQueuedUtterances: Math.floor(boundedNumber(raw.maxQueuedUtterances, 2, 1, 8)),
    speechProcessorPython: optionalString(raw.speechProcessorPython),
  };
}

function pcm16Wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Local media realtime transcription response exceeded the size limit");
  }
  if (!response.body) throw new Error("Local media realtime transcription returned no response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error("Local media realtime transcription response exceeded the size limit");
      }
      chunks.push(next.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function transcribeUtterance(params: {
  audio: Buffer;
  sampleRate: number;
  alreadyEnhanced: boolean;
  config: LocalRealtimeConfig;
  acquireLocalService: AcquireLocalService;
  signal: AbortSignal;
  timings: UtteranceTimings;
  onSpeechConfirmed?: () => void;
}): Promise<TranscriptionResult> {
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  const remainingMs = params.config.requestTimeoutMs - elapsedMs(params.timings.endpointAt);
  if (remainingMs <= 0) {
    params.timings.timedOut = true;
    throw new Error("Local media realtime transcription expired in queue");
  }
  const timer = setTimeout(() => {
    params.timings.timedOut = true;
    controller.abort();
  }, remainingMs);
  let lease: Awaited<ReturnType<AcquireLocalService>>;
  let job: ReturnType<typeof createMediaRequestLifecycle> | undefined;
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
    const wav = pcm16Wav(
      params.sampleRate === 16_000 ? params.audio : mulawToPcm(params.audio),
      params.sampleRate,
    );
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
    job = createMediaRequestLifecycle({
      baseUrl: params.config.baseUrl,
      timeoutMs: params.config.requestTimeoutMs - elapsedMs(params.timings.endpointAt),
      signal,
    });
    params.timings.requestId = job.headers["X-OpenClaw-Request-Id"];
    const httpStarted = performance.now();
    let body: unknown;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        signal: job.signal,
        headers: {
          ...job.headers,
          ...(!params.alreadyEnhanced ? { "x-openclaw-speech-input": "agent-speech" } : {}),
          ...(params.onSpeechConfirmed ? { accept: "text/event-stream" } : {}),
        },
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429)
          throw new TranscriptionBusyError("Local media transcription busy");
        throw new Error(`Local media realtime transcription failed with HTTP ${response.status}`);
      }
      if (params.onSpeechConfirmed) {
        return await readTranscriptionEvents(response, job.signal, params.onSpeechConfirmed);
      }
      body = await readBoundedJson(response, job.signal);
    } catch (error) {
      await job.cancel();
      if (error instanceof TranscriptionBusyError) throw error;
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
    return { text: (body as { text: string }).text.trim() };
  } finally {
    job?.finish();
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
  const enhancedLive = Boolean(config.speechProcessorPython);
  const liveSpeechGate = enhancedLive ? createLiveSpeechGate(config) : undefined;
  const liveSpeechDiagnostics = enhancedLive ? createLiveSpeechDiagnostics() : undefined;
  if (request.inputAudioFormat === "pcm16-16khz" && !enhancedLive) {
    throw new Error("Live speech enhancement requires speechProcessorPython");
  }
  const inputSampleRate = enhancedLive ? 16_000 : 8_000;
  const inputBytesPerMs = enhancedLive ? 32 : 8;
  const analysisFrameBytes = inputBytesPerMs * ANALYSIS_FRAME_MS;
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
  let inputFrame = Buffer.alloc(analysisFrameBytes);
  let inputFrameBytes = 0;
  let previousMulawSample = 0;
  let frontEndInputSquares = 0;
  let frontEndInputSamples = 0;
  let inputDiagnosticByte: number | undefined;
  let frontEndOutputSquares = 0;
  let frontEndOutputSamples = 0;
  let frontEndMaxGainDb: number | null = null;
  let frontEndHighProbabilityFrames = 0;
  let frontEndInputNearClipSamples = 0;
  let frontEndOutputNearClipSamples = 0;
  let batchEnhancedSquares = 0;
  let batchOriginalSquares = 0;
  let batchOriginalFrames = 0;
  let batchOriginalPeak: number | null = null;
  let batchProbabilitySum = 0;
  let batchEvidenceFrames = 0;
  let batchHighProbabilityFrames = 0;
  let batchMaxGainDb: number | null = null;
  let connectedAt: number | undefined;
  let lastInputAt: number | undefined;
  let lastRawInputAt: number | undefined;
  let lastLoudAt: number | undefined;
  // Random and scoped to this connection, never derived from an agent/user/session.
  const diagnosticCallId = randomUUID();
  let diagnosticSectionOrdinal = 0;
  let summaryReported = false;
  let inputGapTimer: NodeJS.Timeout | undefined;
  let consecutiveLoudMs = 0;
  let utteranceSequence = 0n;
  let speechGeneration = 0;
  let currentTurn: TranscriptTurn = {
    controller: new AbortController(),
    text: "",
    generation: 0,
    trustedSpeechRmsSum: 0,
    trustedSpeechFrames: 0,
  };
  const transcriptTurns = new Set<TranscriptTurn>();
  const pendingUtterances = new Set<string>();

  const notifyProcessing = (utteranceId: string, state: ProcessingState) => {
    try {
      request.onProcessing?.({ utteranceId, state });
    } catch {
      // Notifications must not prevent cancellation or release of media resources.
    }
  };
  const notifyActivity = (utteranceId: string, state: "candidate" | "sustained" | "rejected") => {
    try {
      request.onSpeechActivity?.({ utteranceId, state });
    } catch {
      // Acoustic hints must not interrupt capture or transcription.
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
      turn.controller.abort();
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
    interruptedInputs: 0,
  };

  const captureTimings = (): UtteranceTimings => ({
    sectionOrdinal: (diagnosticSectionOrdinal = boundedAdd(diagnosticSectionOrdinal, 1)),
    utteranceOrdinal: currentTurn.generation,
    requestId: null,
    endpointAt: performance.now(),
    endpointSilenceWallMs: lastLoudAt === undefined ? 0 : elapsedMs(lastLoudAt),
    trailingSilenceAudioMs: quietMs,
    utteranceAudioMs: utteranceBytes / inputBytesPerMs,
    queueWaitMs: null,
    acquireMs: null,
    httpMs: null,
    timedOut: false,
    reported: false,
    enhancedRms:
      batchEvidenceFrames > 0 ? Math.sqrt(batchEnhancedSquares / batchEvidenceFrames) : null,
    originalRms:
      batchOriginalFrames > 0 ? Math.sqrt(batchOriginalSquares / batchOriginalFrames) : null,
    originalPeak: batchOriginalPeak,
    meanSpeechProbability:
      batchEvidenceFrames > 0 ? batchProbabilitySum / batchEvidenceFrames : null,
    highProbabilityFrames: batchHighProbabilityFrames,
    maxGainDb: batchMaxGainDb,
    vadSpeechDurationMs: null,
    decoderSegmentCount: null,
    recognitionSignals: {},
    emptyStage: null,
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
      diagnosticCallId,
      sectionOrdinal: timings.sectionOrdinal,
      utteranceOrdinal: timings.utteranceOrdinal,
      requestId: timings.requestId,
      outcome,
      queueWaitMs: timings.queueWaitMs,
      acquireMs: timings.acquireMs,
      httpMs: timings.httpMs,
      endpointToTranscriptMs: outcome === "transcribed" ? elapsedMs(timings.endpointAt) : null,
      endpointSilenceWallMs: timings.endpointSilenceWallMs,
      trailingSilenceAudioMs: timings.trailingSilenceAudioMs,
      utteranceAudioMs: timings.utteranceAudioMs,
      enhancedRms: timings.enhancedRms,
      originalRms: timings.originalRms,
      originalPeak: timings.originalPeak,
      meanSpeechProbability: timings.meanSpeechProbability,
      highProbabilityFrames: timings.highProbabilityFrames,
      maxGainDb: timings.maxGainDb,
      vadSpeechDurationMs: timings.vadSpeechDurationMs,
      decoderSegmentCount: timings.decoderSegmentCount,
      ...timings.recognitionSignals,
      emptyStage: timings.emptyStage,
    });
  };

  const reportInput = () => {
    if (summaryReported) {
      return;
    }
    summaryReported = true;
    logDiagnostic(logger, "local_media_stt_input_summary", {
      diagnosticCallId,
      ...input,
      elapsedMs: connectedAt === undefined ? 0 : elapsedMs(connectedAt),
      inputIdleMs: lastInputAt === undefined ? 0 : elapsedMs(lastInputAt),
      pendingUtterances: queued,
      partialFrameBytes: inputFrameBytes,
      ...(enhancedLive
        ? {
            frontEndInputRms:
              frontEndInputSamples > 0
                ? Math.sqrt(frontEndInputSquares / frontEndInputSamples)
                : null,
            frontEndOutputRms:
              frontEndOutputSamples > 0
                ? Math.sqrt(frontEndOutputSquares / frontEndOutputSamples)
                : null,
            frontEndMaxGainDb,
            frontEndHighProbabilityFrames,
            frontEndInputNearClipSamples,
            frontEndOutputNearClipSamples,
            ...liveSpeechDiagnostics?.snapshot(),
          }
        : {}),
    });
  };

  const recordFrontEndRms = (audio: Buffer, output: boolean) => {
    if (!output) {
      // Transport fragments can split a PCM16 sample at either byte. Preserve
      // parity here just as the APM's frame buffer does.
      if (inputDiagnosticByte !== undefined) {
        audio = Buffer.concat([Buffer.from([inputDiagnosticByte]), audio]);
        inputDiagnosticByte = undefined;
      }
      if (audio.byteLength % 2 !== 0) {
        inputDiagnosticByte = audio[audio.byteLength - 1];
        audio = audio.subarray(0, -1);
      }
    }
    let squares = 0;
    const completeBytes = audio.byteLength - (audio.byteLength % 2);
    for (let offset = 0; offset < completeBytes; offset += 2) {
      const sample = audio.readInt16LE(offset) / 32_768;
      squares += sample * sample;
      if (Math.abs(sample) >= 0.98) {
        if (output) frontEndOutputNearClipSamples = boundedAdd(frontEndOutputNearClipSamples, 1);
        else frontEndInputNearClipSamples = boundedAdd(frontEndInputNearClipSamples, 1);
      }
    }
    if (output) {
      frontEndOutputSquares += squares;
      frontEndOutputSamples += completeBytes / 2;
    } else {
      frontEndInputSquares += squares;
      frontEndInputSamples += completeBytes / 2;
    }
  };

  const resetTurn = () => {
    speaking = false;
    onsetMs = 0;
    quietMs = 0;
    speechMs = 0;
    utterance = [];
    utteranceBytes = 0;
    batchEnhancedSquares = 0;
    batchOriginalSquares = 0;
    batchOriginalFrames = 0;
    batchOriginalPeak = null;
    batchProbabilitySum = 0;
    batchEvidenceFrames = 0;
    batchHighProbabilityFrames = 0;
    batchMaxGainDb = null;
  };

  const discardInput = () => {
    if (inputGapTimer) clearTimeout(inputGapTimer);
    inputGapTimer = undefined;
    if (speaking) {
      reportUtterance(captureTimings(), "cancelled");
    }
    reportInput();
    resetTurn();
    preRoll = [];
    preRollBytes = 0;
    inputFrame = Buffer.alloc(analysisFrameBytes);
    inputFrameBytes = 0;
  };

  const fail = (error: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    connected = false;
    processor?.close();
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
    // A size-capped batch can be rejected while its user is still speaking.
    // Its later endpoint must not reopen processing ownership for a dead turn.
    if (turn.discarded) {
      reportUtterance(timings, "cancelled");
      return;
    }
    if (queued >= config.maxQueuedUtterances) {
      reportUtterance(timings, "queue_overflow");
      fail(new Error("Local media realtime transcription queue limit exceeded"));
      return;
    }
    // Audio caps bound STT work, not user turns. Only silence admits a final turn.
    const utteranceId = silenceEndpoint ? turn.utteranceId : undefined;
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
          const result = await transcribeUtterance({
            audio,
            sampleRate: inputSampleRate,
            alreadyEnhanced: enhancedLive,
            config,
            acquireLocalService,
            signal: AbortSignal.any([sessionController.signal, turn.controller.signal]),
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
          const text = result.text;
          if (result.recognition) {
            timings.vadSpeechDurationMs = result.recognition.speechDurationMs;
            timings.decoderSegmentCount = result.recognition.segmentCount;
            // Log only known numeric observations with bounded semantics. An
            // arbitrary backend metric name must never become log content.
            const knownSignals = [
              ["fasterWhisper.avgLogProbability", "decoderAvgLogProbability", -100, 0],
              ["fasterWhisper.noSpeechProbability", "decoderNoSpeechProbability", 0, 1],
              ["fasterWhisper.compressionRatio", "decoderCompressionRatio", 0, 100],
            ] as const;
            for (const [name, field, minimum, maximum] of knownSignals) {
              const observation = result.recognition.signals?.find((item) => item.name === name);
              if (
                observation &&
                Number.isFinite(observation.mean) &&
                observation.mean >= minimum &&
                observation.mean <= maximum &&
                Number.isSafeInteger(observation.samples) &&
                observation.samples >= 1
              ) {
                timings.recognitionSignals[field] = observation.mean;
                timings.recognitionSignals[`${field}Samples`] = observation.samples;
              }
            }
          }
          if (!text) {
            timings.emptyStage =
              timings.vadSpeechDurationMs === 0
                ? "vad"
                : timings.vadSpeechDurationMs !== null
                  ? "decoder"
                  : "unknown";
          }
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
              if (
                finalText &&
                result.recognition &&
                turn.trustedSpeechFrames > 0 &&
                turn.speechObservation
              ) {
                liveSpeechGate?.acceptRecognizedSpeech({
                  observation: turn.speechObservation,
                  speechRms: turn.trustedSpeechRmsSum / turn.trustedSpeechFrames,
                  speechFrames: turn.trustedSpeechFrames,
                  speechDurationMs: result.recognition.speechDurationMs,
                  segmentCount: result.recognition.segmentCount,
                });
              }
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
          if (turn.discarded && !closed) {
            if (turn.utteranceId) settleProcessing(turn.utteranceId, "cancelled");
            reportUtterance(timings, "cancelled");
            return;
          }
          if (turn.utteranceId) {
            settleProcessing(turn.utteranceId, closed ? "cancelled" : "failed");
          }
          reportUtterance(timings, closed ? "cancelled" : timings.timedOut ? "timeout" : "failed");
          if (error instanceof TranscriptionBusyError) {
            // A bounded service queue is a per-turn admission failure. Do not
            // tear down the call or blindly replay a potentially stale command.
            turn.discarded = true;
            turn.text = "";
            transcriptTurns.delete(turn);
            if (turn.utteranceId) notifyActivity(turn.utteranceId, "rejected");
            return;
          }
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
    if (turn.speechObservation && liveSpeechGate && silenceEndpoint) {
      turn.speechObservation.frame = liveSpeechGate.captureObservation().frame;
    }
    turn.minimumSpeechReached ||= speechMs >= config.minSpeechMs;
    const shouldTranscribe =
      (!silenceEndpoint || turn.minimumSpeechReached) && audio.byteLength > 0;
    if (silenceEndpoint) {
      resetTurn();
    } else {
      // Preserve onset and silence accounting across the bounded audio batch.
      utterance = [];
      utteranceBytes = 0;
      batchEnhancedSquares = 0;
      batchOriginalSquares = 0;
      batchOriginalFrames = 0;
      batchOriginalPeak = null;
      batchProbabilitySum = 0;
      batchEvidenceFrames = 0;
      batchHighProbabilityFrames = 0;
      batchMaxGainDb = null;
    }
    if (shouldTranscribe) {
      enqueue(audio, timings, silenceEndpoint, turn);
    } else {
      reportUtterance(timings, "too_short");
      if (silenceEndpoint) {
        if (turn.utteranceId) notifyActivity(turn.utteranceId, "rejected");
        turn.discarded = true;
        turn.controller.abort();
        turn.text = "";
        transcriptTurns.delete(turn);
      }
    }
  };

  const retainPreRoll = (audio: Buffer) => {
    const limit = Math.floor(config.preRollMs * inputBytesPerMs);
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

  const analyzeFrame = (chunk: Buffer, evidence?: LiveSpeechEvidence) => {
    const durationMs = ANALYSIS_FRAME_MS;
    let loud: boolean;
    if (liveSpeechGate) {
      if (!evidence) {
        fail(new Error("Live speech processor omitted speech evidence"));
        return;
      }
      loud = liveSpeechGate.observe(evidence);
    } else {
      loud = calculateMulawRms(chunk) >= config.speechRmsThreshold;
    }
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
      currentTurn = {
        controller: new AbortController(),
        text: "",
        generation: speechGeneration,
        trustedSpeechRmsSum: 0,
        trustedSpeechFrames: 0,
        utteranceId: `utterance-${++utteranceSequence}`,
        speechObservation: liveSpeechGate?.captureObservation(),
      };
      transcriptTurns.add(currentTurn);
      input.speechStarts = boundedAdd(input.speechStarts, 1);
      speechMs = onsetMs;
      utterance = preRoll;
      utteranceBytes = preRollBytes;
      preRoll = [];
      preRollBytes = 0;
      request.onSpeechStart?.();
      notifyActivity(currentTurn.utteranceId!, "candidate");
    } else {
      utterance.push(chunk);
      utteranceBytes += chunk.byteLength;
      if (loud) {
        speechMs = boundedAdd(speechMs, durationMs);
      }
    }

    if (loud && evidence && evidence.speechProbability >= 0.85) {
      currentTurn.trustedSpeechRmsSum += evidence.enhancedRms;
      currentTurn.trustedSpeechFrames = boundedAdd(currentTurn.trustedSpeechFrames, 1);
    }

    if (evidence) {
      if (evidence.originalRms !== undefined && evidence.originalPeak !== undefined) {
        batchOriginalSquares += evidence.originalRms * evidence.originalRms;
        batchOriginalFrames = boundedAdd(batchOriginalFrames, 1);
        batchOriginalPeak = Math.max(batchOriginalPeak ?? 0, evidence.originalPeak);
      }
      batchEnhancedSquares += evidence.enhancedRms * evidence.enhancedRms;
      batchProbabilitySum += evidence.speechProbability;
      batchEvidenceFrames = boundedAdd(batchEvidenceFrames, 1);
      if (evidence.speechProbability >= 0.85) {
        batchHighProbabilityFrames = boundedAdd(batchHighProbabilityFrames, 1);
      }
      batchMaxGainDb = Math.max(batchMaxGainDb ?? evidence.gainDb, evidence.gainDb);
    }

    if (!currentTurn.activitySustained && speechMs >= config.minSpeechMs) {
      currentTurn.activitySustained = true;
      notifyActivity(currentTurn.utteranceId!, "sustained");
    }

    quietMs = loud ? 0 : quietMs + durationMs;
    const utteranceMs = utteranceBytes / inputBytesPerMs;
    // Prefer an observed word gap near the hard work cap. This is only a batch
    // boundary, not a user-turn endpoint, and adds neither latency nor overlap.
    const nearCapQuietBoundary =
      utteranceMs >= config.maxUtteranceMs - Math.min(400, config.maxUtteranceMs / 5) &&
      quietMs >= 80;
    if (
      quietMs >= config.silenceMs ||
      nearCapQuietBoundary ||
      utteranceMs >= config.maxUtteranceMs
    ) {
      finishTurn();
    }
  };

  const acceptAudio = (audio: Buffer, evidence?: Omit<LiveSpeechEvidence, "enhancedRms">) => {
    if (!connected || closed || audio.byteLength === 0) {
      return;
    }
    input.count = boundedAdd(input.count, 1);
    const packetAudioMs = audio.byteLength / inputBytesPerMs;
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
      const count = Math.min(analysisFrameBytes - inputFrameBytes, audio.byteLength - offset);
      inputFrame.set(audio.subarray(offset, offset + count), inputFrameBytes);
      inputFrameBytes += count;
      offset += count;
      if (inputFrameBytes === analysisFrameBytes) {
        const frame = inputFrame;
        inputFrame = Buffer.alloc(analysisFrameBytes);
        inputFrameBytes = 0;
        analyzeFrame(frame, evidence && { ...evidence, enhancedRms: calculatePcmRms(frame) });
      }
    }
    if (inputGapTimer) clearTimeout(inputGapTimer);
    inputGapTimer = undefined;
    if (speaking || onsetMs > 0 || inputFrameBytes > 0) {
      inputGapTimer = setTimeout(
        () => {
          inputGapTimer = undefined;
          if (closed) return;
          // Missing transport data is not acoustic silence. Drop an incomplete
          // command rather than dispatching its truncated transcript on a timer.
          if (speaking) {
            reportUtterance(captureTimings(), "cancelled");
            currentTurn.discarded = true;
            currentTurn.controller.abort();
            currentTurn.text = "";
            transcriptTurns.delete(currentTurn);
            if (currentTurn.utteranceId) notifyActivity(currentTurn.utteranceId, "rejected");
          }
          input.interruptedInputs = boundedAdd(input.interruptedInputs, 1);
          resetTurn();
          preRoll = [];
          preRollBytes = 0;
          inputFrame = Buffer.alloc(analysisFrameBytes);
          inputFrameBytes = 0;
          previousMulawSample = 0;
          inputDiagnosticByte = undefined;
          processor?.discardPartialInput();
        },
        Math.max(2_000, config.silenceMs * 2),
      );
      inputGapTimer.unref?.();
    }
  };
  const processor = config.speechProcessorPython
    ? createLiveSpeechProcessor({
        python: config.speechProcessorPython,
        onFrame: (frame) => {
          liveSpeechDiagnostics?.observe(frame);
          recordFrontEndRms(frame.audio, true);
          frontEndMaxGainDb = Math.max(frontEndMaxGainDb ?? frame.gainDb, frame.gainDb);
          if (frame.speechProbability >= config.speechProbabilityThreshold) {
            frontEndHighProbabilityFrames = boundedAdd(frontEndHighProbabilityFrames, 1);
          }
          acceptAudio(frame.audio, {
            speechProbability: frame.speechProbability,
            gainDb: frame.gainDb,
            originalRms: frame.originalRms,
            originalPeak: frame.originalPeak,
          });
        },
        onError: fail,
      })
    : undefined;

  return {
    async connect() {
      if (closed) {
        throw new Error("Local media realtime transcription session is closed");
      }
      await processor?.connect();
      connected = true;
      connectedAt ??= performance.now();
    },
    sendAudio(audio) {
      if (!connected || closed || audio.byteLength === 0) return;
      if (lastRawInputAt !== undefined && elapsedMs(lastRawInputAt) >= 2_000) {
        inputDiagnosticByte = undefined;
      }
      lastRawInputAt = performance.now();
      if (processor) {
        if (request.inputAudioFormat === "pcm16-16khz") {
          recordFrontEndRms(audio, false);
          processor.send(audio);
        } else {
          const upsampled = Buffer.allocUnsafe(audio.byteLength * 4);
          for (let index = 0; index < audio.byteLength; index += 1) {
            const current = decodeMulawByte(audio[index] ?? 0);
            upsampled.writeInt16LE(Math.round((previousMulawSample + current) / 2), index * 4);
            upsampled.writeInt16LE(current, index * 4 + 2);
            previousMulawSample = current;
          }
          recordFrontEndRms(upsampled, false);
          processor.send(upsampled);
        }
      } else {
        acceptAudio(audio);
      }
    },
    close() {
      closed = true;
      connected = false;
      processor?.close();
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
    resolveInputAudioFormat: (providerConfig) =>
      normalizeConfig(providerConfig).speechProcessorPython ? "pcm16-16khz" : "g711-ulaw-8khz",
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
      const lease = await acquireLocalService(
        { providerId: LOCAL_MEDIA_PROVIDER_ID, baseUrl: config.baseUrl },
        signal,
      );
      if (!config.speechProcessorPython) return lease;
      let probe: ReturnType<typeof createLiveSpeechProcessor> | undefined;
      const abortProbe = () => probe?.close();
      try {
        probe = createLiveSpeechProcessor({
          python: config.speechProcessorPython,
          onFrame: () => undefined,
          onError: () => undefined,
        });
        signal?.addEventListener("abort", abortProbe, { once: true });
        signal?.throwIfAborted();
        await probe.connect();
        signal?.throwIfAborted();
        return lease;
      } catch (error) {
        await lease?.release();
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortProbe);
        probe?.close();
      }
    },
    createSession: (request) => createSession(request, acquireLocalService, logger),
  };
}
