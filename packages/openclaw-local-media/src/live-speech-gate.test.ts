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
});
