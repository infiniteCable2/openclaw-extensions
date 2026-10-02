/** Offline replay of a consented WAV through the actual realtime APM/gate path.
 * No gateway, model, lease broker, network request, or transcript output.
 */
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildLocalRealtimeTranscriptionProvider } from "../dist/realtime-transcription-provider.js";

const FRAME_BYTES = 640;
const MAX_SECONDS = 60;

function pcm16Mono16k(wav) {
  if (wav.byteLength < 44 || wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Replay requires a RIFF/WAVE file");
  }
  let format;
  let audio;
  for (let offset = 12; offset + 8 <= wav.byteLength;) {
    const kind = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > wav.byteLength - start) throw new Error("Invalid WAV chunk length");
    if (kind === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format chunk");
      format = {
        encoding: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        rate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    } else if (kind === "data") {
      audio = wav.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 ||
      format.rate !== 16_000 || format.bits !== 16 || !audio ||
      audio.byteLength === 0 || audio.byteLength > MAX_SECONDS * 32_000 ||
      audio.byteLength % 2 !== 0) {
    throw new Error("Replay requires at most 60 seconds of 16-kHz mono PCM16 audio");
  }
  return audio;
}

async function main() {
  const python = process.env.OPENCLAW_STT_REPLAY_PYTHON;
  const file = process.argv[2];
  const region = process.argv[3] ?? "full";
  if (!python || !file) throw new Error("Set OPENCLAW_STT_REPLAY_PYTHON and provide one WAV path");
  if (!["full", "first5", "last5"].includes(region)) {
    throw new Error("Replay region must be full, first5, or last5");
  }
  if ((await stat(file)).size > MAX_SECONDS * 32_000 + 4_096) {
    throw new Error("Replay WAV exceeds the byte limit");
  }
  const source = pcm16Mono16k(await readFile(file));
  const fiveSeconds = 5 * 32_000;
  const audio = region === "first5" ? source.subarray(0, fiveSeconds)
    : region === "last5" ? source.subarray(Math.max(0, source.byteLength - fiveSeconds))
      : source;
  const counters = { candidate: 0, sustained: 0, rejected: 0, started: 0,
    transcribed: 0, empty: 0, failed: 0, cancelled: 0 };
  const diagnostics = [];
  let requests = 0;
  let releases = 0;
  let fatal;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== "http://127.0.0.1:8010/v1/audio/transcriptions" ||
        init?.method !== "POST") {
      throw new Error("Unexpected offline replay request");
    }
    requests += 1;
    return new Response(
      'data: {"type":"transcript.done","text":"","model":"offline","recognition":{"speechDurationMs":0,"segmentCount":0}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const provider = buildLocalRealtimeTranscriptionProvider(
    async () => ({ release: () => { releases += 1; } }),
    { info: (message) => {
      const item = JSON.parse(message);
      if (item.event === "local_media_stt_input_summary" ||
          item.event === "local_media_stt_utterance") diagnostics.push(item);
    } },
  );
  const session = provider.createSession({
    inputAudioFormat: "pcm16-16khz",
    providerConfig: {
      baseUrl: "http://127.0.0.1:8010/v1",
      speechProcessorPython: python,
    },
    onSpeechActivity: ({ state }) => { counters[state] += 1; },
    onProcessing: ({ state }) => { if (state in counters) counters[state] += 1; },
    onError: (error) => { fatal = error; },
  });
  try {
    await session.connect();
    const paddedBytes = Math.ceil(audio.byteLength / FRAME_BYTES) * FRAME_BYTES;
    const replay = Buffer.alloc(paddedBytes + 32_000); // one second of silence to close a turn
    audio.copy(replay);
    for (let offset = 0; offset < replay.byteLength; offset += FRAME_BYTES * 10) {
      session.sendAudio(replay.subarray(offset, offset + FRAME_BYTES * 10));
      await delay(10);
      if (fatal) break;
    }
    await delay(300);
    session.close();
    const summary = diagnostics.find((item) => item.event === "local_media_stt_input_summary");
    if (fatal || !summary || summary.frames !== replay.byteLength / FRAME_BYTES ||
        requests !== releases) {
      throw new Error("Offline replay did not drain cleanly");
    }
    console.log(JSON.stringify({
      region,
      sourceAudioMs: audio.byteLength / 32,
      analyzedFrames: summary.frames,
      speechStarts: summary.speechStarts,
      endpoints: summary.endpoints,
      completed: summary.completed,
      dropped: summary.dropped,
      candidate: counters.candidate,
      sustained: counters.sustained,
      rejected: counters.rejected,
      sttRequestsIntercepted: requests,
      inputRms: summary.frontEndInputRms,
      outputRms: summary.frontEndOutputRms,
      maxGainDb: summary.frontEndMaxGainDb,
      inputNearClipSamples: summary.frontEndInputNearClipSamples,
      outputNearClipSamples: summary.frontEndOutputNearClipSamples,
    }));
  } finally {
    session.close();
    globalThis.fetch = originalFetch;
  }
}

await main();
