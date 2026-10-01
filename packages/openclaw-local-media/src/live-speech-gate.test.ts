import { describe, expect, it } from "vitest";
import { createLiveSpeechGate } from "./live-speech-gate.js";

const config = {
  speechRmsThreshold: 0.015,
  speechProbabilityThreshold: 0.6,
  speechNoiseMarginDb: 3.5,
};

describe("live speech evidence gate", () => {
  it("does not mistake amplified persistent noise for speech", () => {
    const gate = createLiveSpeechGate(config);
    for (let index = 0; index < 200; index += 1) {
      const gainDb = Math.min(12, index / 12);
      const enhancedRms = 0.012 * 10 ** (gainDb / 20);
      expect(gate.observe({ enhancedRms, speechProbability: 0.2, gainDb })).toBe(false);
    }
  });

  it("allows confident quiet speech after the noise estimate settles", () => {
    const gate = createLiveSpeechGate(config);
    for (let index = 0; index < 50; index += 1) {
      gate.observe({ enhancedRms: 0.004, speechProbability: 0.2, gainDb: 0 });
    }
    expect(gate.observe({ enhancedRms: 0.009, speechProbability: 0.9, gainDb: 6 })).toBe(true);
  });

  it("requires both nontrivial energy and speech evidence", () => {
    const gate = createLiveSpeechGate(config);
    expect(gate.observe({ enhancedRms: 0, speechProbability: 0.99, gainDb: 12 })).toBe(false);
    expect(gate.observe({ enhancedRms: 0.2, speechProbability: 0.1, gainDb: 12 })).toBe(false);
  });

  it("slowly accepts corroborated quiet speech within a per-call bound", () => {
    const gate = createLiveSpeechGate(config);
    const quiet = { enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 };
    expect(gate.observe(quiet)).toBe(false);
    gate.acceptRecognizedSpeech({
      speechRms: 0.008, speechFrames: 20, speechDurationMs: 700, segmentCount: 1,
    });
    expect(gate.observe(quiet)).toBe(true);
    expect(createLiveSpeechGate(config).observe(quiet)).toBe(false);
    expect(gate.observe({ ...quiet, speechProbability: 0.2 })).toBe(false);
  });

  it("does not learn from absent or weak recognition evidence", () => {
    const gate = createLiveSpeechGate(config);
    const quiet = { enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 };
    gate.acceptRecognizedSpeech({
      speechRms: 0.008, speechFrames: 20, speechDurationMs: null, segmentCount: 1,
    });
    gate.acceptRecognizedSpeech({
      speechRms: 0.008, speechFrames: 2, speechDurationMs: 700, segmentCount: 1,
    });
    gate.acceptRecognizedSpeech({
      speechRms: 0.008, speechFrames: 20, speechDurationMs: 700, segmentCount: 0,
    });
    expect(gate.observe(quiet)).toBe(false);
  });

  it("never adapts below the hard per-call energy floor", () => {
    const gate = createLiveSpeechGate(config);
    for (let index = 0; index < 100; index += 1) {
      gate.acceptRecognizedSpeech({
        speechRms: 0.005, speechFrames: 20, speechDurationMs: 700, segmentCount: 1,
      });
    }
    expect(gate.observe({ enhancedRms: 0.0044, speechProbability: 0.9, gainDb: 0 })).toBe(false);
    expect(gate.observe({ enhancedRms: 0.0046, speechProbability: 0.9, gainDb: 0 })).toBe(true);
  });
});
