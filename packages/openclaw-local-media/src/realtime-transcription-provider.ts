import {
  type OpenClawPluginApi,
  type RealtimeTranscriptionProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_STT_MODEL, LOCAL_MEDIA_PROVIDER_ID } from "./constants.js";
import { createLiveSpeechGate, type LiveSpeechEvidence } from "./live-speech-gate.js";
import { requireLoopbackBaseUrl } from "./local-url.js";
import { createLiveSpeechProcessor } from "./live-speech-processor.js";
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
  text: string;
  generation: number;
  utteranceId?: string;
  speechConfirmed?: boolean;
  confirmationPublished?: boolean;
  minimumSpeechReached?: boolean;
  activitySustained?: boolean;
  discarded?: boolean;
};

const ANALYSIS_FRAME_MS = 20;
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
  sampleRate: number;
  alreadyEnhanced: boolean;
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
    const httpStarted = performance.now();
    let body: unknown;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: form,
        signal,
        headers: {
          ...(!params.alreadyEnhanced ? { "x-openclaw-speech-input": "agent-speech" } : {}),
          ...(params.onSpeechConfirmed ? { accept: "text/event-stream" } : {}),
        },
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
  const enhancedLive = Boolean(config.speechProcessorPython);
  const liveSpeechGate = enhancedLive ? createLiveSpeechGate(config) : undefined;
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
  let frontEndOutputSquares = 0;
  let frontEndOutputSamples = 0;
  let frontEndMaxGainDb: number | null = null;
  let frontEndHighProbabilityFrames = 0;
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
    utteranceAudioMs: utteranceBytes / inputBytesPerMs,
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
          }
        : {}),
    });
  };

  const recordFrontEndRms = (audio: Buffer, output: boolean) => {
    let squares = 0;
    const completeBytes = audio.byteLength - (audio.byteLength % 2);
    for (let offset = 0; offset < completeBytes; offset += 2) {
      const sample = audio.readInt16LE(offset) / 32_768;
      squares += sample * sample;
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
  };

  const discardInput = () => {
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
          const text = await transcribeUtterance({
            audio,
            sampleRate: inputSampleRate,
            alreadyEnhanced: enhancedLive,
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
        if (turn.utteranceId) notifyActivity(turn.utteranceId, "rejected");
        turn.discarded = true;
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
        text: "",
        generation: speechGeneration,
        utteranceId: `utterance-${++utteranceSequence}`,
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

    if (!currentTurn.activitySustained && speechMs >= config.minSpeechMs) {
      currentTurn.activitySustained = true;
      notifyActivity(currentTurn.utteranceId!, "sustained");
    }

    quietMs = loud ? 0 : quietMs + durationMs;
    const utteranceMs = utteranceBytes / inputBytesPerMs;
    if (quietMs >= config.silenceMs || utteranceMs >= config.maxUtteranceMs) {
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
        analyzeFrame(
          frame,
          evidence && { ...evidence, enhancedRms: calculatePcmRms(frame) },
        );
      }
    }
  };
  const processor = config.speechProcessorPython
    ? createLiveSpeechProcessor({
        python: config.speechProcessorPython,
        onFrame: (frame) => {
          recordFrontEndRms(frame.audio, true);
          frontEndMaxGainDb = Math.max(frontEndMaxGainDb ?? frame.gainDb, frame.gainDb);
          if (frame.speechProbability >= config.speechProbabilityThreshold) {
            frontEndHighProbabilityFrames = boundedAdd(frontEndHighProbabilityFrames, 1);
          }
          acceptAudio(frame.audio, {
            speechProbability: frame.speechProbability,
            gainDb: frame.gainDb,
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
