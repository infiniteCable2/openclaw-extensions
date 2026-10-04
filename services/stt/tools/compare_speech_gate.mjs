// Numeric offline probe of the actual gate, not a copied implementation.
import { createInterface } from "node:readline";
import { createLiveSpeechGate } from "../../../packages/openclaw-local-media/src/live-speech-gate.ts";

const config = {
  speechRmsThreshold: 0.015,
  speechProbabilityThreshold: 0.6,
  speechNoiseMarginDb: 3.5,
};
let sequence;
let sequenceGates;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.length > 2_000_000) throw new Error("probe evidence exceeds its limit");
  const input = JSON.parse(line);
  if (!input.sequence || input.sequence !== sequence) {
    sequence = input.sequence;
    sequenceGates = { baseline: createLiveSpeechGate(config), candidate: createLiveSpeechGate(config) };
  }
  const summary = { case: input.case, durationMs: input.durationMs };
  for (const profile of ["baseline", "candidate"]) {
    const { frames, ...metrics } = input[profile];
    if (!Array.isArray(frames) || frames.length > 3_000) throw new Error("invalid frame count");
    const gate = sequenceGates[profile];
    let accepted = 0;
    let run = 0;
    let longest = 0;
    let sustained = 0;
    const candidateStartsMs = [];
    for (const [index, frame] of frames.entries()) {
      if (gate.observe(frame)) {
        accepted++;
        run++;
        longest = Math.max(longest, run);
        if (run === 8) {
          sustained++;
          if (candidateStartsMs.length < 8) candidateStartsMs.push((index - 7) * 20);
        }
      } else {
        run = 0;
      }
    }
    summary[profile] = {
      ...metrics,
      acceptedFrameFraction: accepted / frames.length,
      highProbabilityFrameFraction: frames.filter((frame) => frame.speechProbability >= 0.85).length / frames.length,
      longestAcceptedMs: longest * 20,
      runsAtLeast160Ms: sustained,
      candidateStartsMs,
    };
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
