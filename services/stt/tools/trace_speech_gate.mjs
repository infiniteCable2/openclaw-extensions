// Offline measurement of the real live gate. Input is numeric APM JSONL, never media.
import { createInterface } from "node:readline";
import { createLiveSpeechGate } from "../../../packages/openclaw-local-media/src/live-speech-gate.ts";

const gate = createLiveSpeechGate({
  speechRmsThreshold: 0.015,
  speechProbabilityThreshold: 0.6,
  speechNoiseMarginDb: 3.5,
});
const results = [];
let current;
let seen = 0;

function finish() {
  if (!current) return;
  const { count } = current;
  results.push({
    tMs: current.tMs,
    phase: current.phase,
    durationMs: count * 20,
    originalRms: Math.sqrt(current.originalPower / count),
    enhancedRms: Math.sqrt(current.enhancedPower / count),
    cleanRms: Math.sqrt(current.cleanPower / count),
    speechProbability: current.probability / count,
    gainDb: current.gain / count,
    noiseRms: current.noise / count,
    learnedMinimumOutputRms: current.minimum / count,
    acceptedFraction: current.accepted / count,
    clippedFraction: current.clipped / count,
    originalPeak: current.peak,
  });
  current = undefined;
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 2_000 || ++seen > 10_000) throw new Error("trace input exceeds bound");
  const item = JSON.parse(line);
  if (!Number.isSafeInteger(item.tMs) || item.tMs !== (seen - 1) * 20 ||
      typeof item.phase !== "string" || !/^[a-z_]{1,40}$/.test(item.phase)) {
    throw new Error("invalid trace frame");
  }
  for (const key of ["originalRms", "originalPeak", "enhancedRms", "speechProbability",
    "gainDb", "cleanRms", "clippedFrames"]) {
    if (!Number.isFinite(item[key])) throw new Error("nonfinite trace measurement");
  }
  const accepted = gate.observe(item);
  const snapshot = gate.snapshot();
  if (!current || current.phase !== item.phase || current.count === 50) {
    finish();
    current = { tMs: item.tMs, phase: item.phase, count: 0, originalPower: 0,
      enhancedPower: 0, cleanPower: 0, probability: 0, gain: 0,
      noise: 0, minimum: 0, accepted: 0, clipped: 0, peak: 0 };
  }
  current.count += 1;
  current.originalPower += item.originalRms ** 2;
  current.enhancedPower += item.enhancedRms ** 2;
  current.cleanPower += item.cleanRms ** 2;
  current.probability += item.speechProbability;
  current.gain += item.gainDb;
  current.noise += snapshot.noiseRms;
  current.minimum += snapshot.learnedMinimumOutputRms;
  current.accepted += Number(accepted);
  current.clipped += Number(item.clippedFrames > 0);
  current.peak = Math.max(current.peak, item.originalPeak);
}
finish();
if (seen < 100 || results.length < 2) throw new Error("trace too short");
process.stdout.write(`${JSON.stringify({ frameCount: seen, bins: results })}\n`);
