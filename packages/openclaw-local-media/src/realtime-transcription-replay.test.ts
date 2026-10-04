import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLocalRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";
import { createLiveSpeechProcessor, type LiveSpeechFrame } from "./live-speech-processor.js";

vi.mock("./live-speech-processor.js", () => ({ createLiveSpeechProcessor: vi.fn() }));

type ReplayFrame = { rms: number; probability: number; gainDb: number };
const FRAME_BYTES = 640;
const FRAME_MS = 20;

function pcmAtRms(rms: number): Buffer {
  const audio = Buffer.alloc(FRAME_BYTES);
  const sample = Math.min(32_767, Math.round(rms * 32_768));
  for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
    audio.writeInt16LE(offset % 4 === 0 ? sample : -sample, offset);
  }
  return audio;
}

function frames(count: number, rms: number, probability: number, gainDb = 0): ReplayFrame[] {
  return Array.from({ length: count }, () => ({ rms, probability, gainDb }));
}

function replayWorker(evidence: ReplayFrame[]) {
  let sent = 0;
  let pending = Buffer.alloc(0);
  vi.mocked(createLiveSpeechProcessor).mockImplementation(({ onFrame }) => ({
    async connect() {},
    send(audio) {
      pending = Buffer.concat([pending, audio]);
      while (pending.byteLength >= FRAME_BYTES) {
        pending = pending.subarray(FRAME_BYTES);
        const item = evidence[sent++];
        if (!item) throw new Error("Replay received more audio than evidence frames");
        const frame: LiveSpeechFrame = {
          audio: pcmAtRms(item.rms),
          speechProbability: item.probability,
          gainDb: item.gainDb,
          originalRms: item.rms / 10 ** (item.gainDb / 20),
          originalPeak: item.rms / 10 ** (item.gainDb / 20),
        };
        onFrame(frame);
      }
    },
    close() {},
    discardPartialInput() {
      pending = Buffer.alloc(0);
    },
  }));
  return () => sent;
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Replay did not settle");
}

async function runReplay(evidence: ReplayFrame[], packetSizes: number[], expectTranscript = false) {
  const seen = replayWorker(evidence);
  const acquire = vi.fn(async () => ({ release: vi.fn() }));
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(
        `data: ${JSON.stringify({ type: "transcript.done", text: "recognized", model: "test" })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const events: string[] = [];
  const transcripts: string[] = [];
  const errors: Error[] = [];
  const session = buildLocalRealtimeTranscriptionProvider(acquire).createSession({
    inputAudioFormat: "pcm16-16khz",
    providerConfig: {
      baseUrl: "http://127.0.0.1:8010/v1",
      speechProcessorPython: "/test/python",
      speechOnsetMs: 80,
      minSpeechMs: 160,
      silenceMs: 700,
      preRollMs: 240,
    },
    onSpeechStart: () => events.push("start"),
    onSpeechActivity: ({ state }) => events.push(state),
    onProcessing: ({ state }) => events.push(state),
    onTranscript: (text) => transcripts.push(text),
    onError: (error) => errors.push(error),
  });
  try {
    await session.connect();
    // The transport has deliberately irregular boundaries, including partial frames.
    const input = Buffer.alloc(evidence.length * FRAME_BYTES);
    let offset = 0;
    let index = 0;
    while (offset < input.byteLength) {
      const end = Math.min(
        input.byteLength,
        offset + (packetSizes[index++ % packetSizes.length] ?? FRAME_BYTES),
      );
      session.sendAudio(input.subarray(offset, end));
      offset = end;
    }
    expect(seen()).toBe(evidence.length);
    if (expectTranscript) await waitFor(() => transcripts.length > 0 || errors.length > 0);
    return { events, transcripts, errors, fetchMock, acquire };
  } finally {
    session.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(createLiveSpeechProcessor).mockReset();
});

describe("agent-directed live speech replay (APM evidence supplied, no recognition model)", () => {
  it.each([
    ["aligned", [FRAME_BYTES]],
    ["fragmented", [1, 73, 991, 17]],
  ])("keeps a short utterance and its endpoint across %s packets", async (_name, sizes) => {
    const evidence = [
      ...frames(50, 0.003, 0.1),
      ...frames(12, 0.022, 0.9, 6),
      ...frames(35, 0.003, 0.1),
    ];
    const result = await runReplay(evidence, sizes, true);
    expect(result.errors).toEqual([]);
    expect(result.events).toContain("candidate");
    expect(result.events).toContain("sustained");
    expect(result.events).toContain("started");
    expect(result.events).toContain("transcribed");
    expect(result.transcripts).toEqual(["recognized"]);
    expect(result.fetchMock).toHaveBeenCalledOnce();
    const init = result.fetchMock.mock.calls[0]?.[1] as RequestInit;
    const wav = Buffer.from(await ((init.body as FormData).get("file") as File).arrayBuffer());
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(40) / 32).toBeGreaterThanOrEqual(12 * FRAME_MS + 700);
    expect(new Headers(init.headers).has("x-openclaw-speech-input")).toBe(false);
  });

  it("does not treat increasing gain on steady noise or brief bumps as a turn", async () => {
    const road = Array.from({ length: 150 }, (_, index) => ({
      rms: 0.009 * 10 ** (Math.min(12, index / 10) / 20),
      probability: 0.18,
      gainDb: Math.min(12, index / 10),
    }));
    const bumps = [...frames(2, 0.25, 0.9, 12), ...frames(10, 0.015, 0.15, 12)];
    const result = await runReplay([...road, ...bumps], [7, 319, 51, 163]);
    expect(result.events).toEqual([]);
    expect(result.transcripts).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.fetchMock).not.toHaveBeenCalled();
    expect(result.acquire).not.toHaveBeenCalled();
  });
});
