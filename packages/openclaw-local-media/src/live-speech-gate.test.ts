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

  it("does not let high speech probability alone bypass a learned loud background", () => {
    const gate = createLiveSpeechGate(config);
    for (let index = 0; index < 200; index += 1) {
      expect(gate.observe({ enhancedRms: 0.12, speechProbability: 0.2, gainDb: 0 })).toBe(false);
    }
    for (let index = 0; index < 50; index += 1) {
      expect(
        gate.observe({
          enhancedRms: 0.12 * 10 ** (6 / 20),
          speechProbability: 0.95,
          gainDb: 6,
        }),
      ).toBe(false);
    }
    for (let index = 0; index < 100; index += 1) {
      expect(
        gate.observe({
          enhancedRms: 0.14 * 10 ** (6 / 20),
          speechProbability: 0.95,
          gainDb: 6,
        }),
      ).toBe(true);
    }
  });

  it("does not absorb a sustained quiet utterance into background during gain changes", () => {
    const gate = createLiveSpeechGate(config);
    for (let index = 0; index < 200; index += 1) {
      gate.observe({ enhancedRms: 0.12, speechProbability: 0.2, gainDb: 0 });
    }
    for (let index = 0; index < 200; index += 1) {
      const gainDb = index % 13;
      expect(
        gate.observe({
          enhancedRms: 0.14 * 10 ** (gainDb / 20),
          speechProbability: 0.95,
          gainDb,
          originalRms: 0.2,
          originalPeak: 0.6,
        }),
      ).toBe(true);
    }
    for (let index = 0; index < 100; index += 1) {
      expect(gate.observe({ enhancedRms: 0.2, speechProbability: 0.2, gainDb: 0 })).toBe(false);
    }
    expect(gate.observe({ enhancedRms: 0.21, speechProbability: 0.95, gainDb: 0 })).toBe(false);
    expect(gate.observe({ enhancedRms: 0.24, speechProbability: 0.95, gainDb: 0 })).toBe(true);
  });

  it("does not turn APM residual energy with zero original input into speech", () => {
    const gate = createLiveSpeechGate(config);
    expect(
      gate.observe({
        enhancedRms: 0.02,
        speechProbability: 0.95,
        gainDb: 12,
        originalRms: 0,
        originalPeak: 0,
      }),
    ).toBe(false);
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
      observation: gate.captureObservation(),
      speechRms: 0.008,
      speechFrames: 20,
      speechDurationMs: 700,
      segmentCount: 1,
    });
    expect(gate.observe(quiet)).toBe(true);
    expect(createLiveSpeechGate(config).observe(quiet)).toBe(false);
    expect(gate.observe({ ...quiet, speechProbability: 0.2 })).toBe(false);
  });

  it("does not learn from absent or weak recognition evidence", () => {
    const gate = createLiveSpeechGate(config);
    const quiet = { enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 };
    gate.acceptRecognizedSpeech({
      observation: gate.captureObservation(),
      speechRms: 0.008,
      speechFrames: 20,
      speechDurationMs: null,
      segmentCount: 1,
    });
    gate.acceptRecognizedSpeech({
      observation: gate.captureObservation(),
      speechRms: 0.008,
      speechFrames: 2,
      speechDurationMs: 700,
      segmentCount: 1,
    });
    gate.acceptRecognizedSpeech({
      observation: gate.captureObservation(),
      speechRms: 0.008,
      speechFrames: 20,
      speechDurationMs: 700,
      segmentCount: 0,
    });
    expect(gate.observe(quiet)).toBe(false);
  });

  it("never adapts below the hard per-call energy floor", () => {
    const gate = createLiveSpeechGate(config);
    for (let index = 0; index < 100; index += 1) {
      gate.observe({ enhancedRms: 0.001, speechProbability: 0.1, gainDb: 0 });
      gate.acceptRecognizedSpeech({
        observation: gate.captureObservation(),
        speechRms: 0.005,
        speechFrames: 20,
        speechDurationMs: 700,
        segmentCount: 1,
      });
    }
    expect(gate.observe({ enhancedRms: 0.0044, speechProbability: 0.9, gainDb: 0 })).toBe(false);
    expect(gate.observe({ enhancedRms: 0.0046, speechProbability: 0.9, gainDb: 0 })).toBe(true);
  });

  it("recovers expired sensitivity during nonspeech, never by swallowing ongoing speech", () => {
    const gate = createLiveSpeechGate(config);
    gate.acceptRecognizedSpeech({
      observation: gate.captureObservation(),
      speechRms: 0.008,
      speechFrames: 20,
      speechDurationMs: 700,
      segmentCount: 1,
    });
    const quiet = { enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 };
    for (let i = 0; i < 2_000; i++) expect(gate.observe(quiet)).toBe(true);
    for (let i = 0; i < 2_000; i++) {
      expect(gate.observe({ enhancedRms: 0.001, speechProbability: 0.1, gainDb: 0 })).toBe(false);
    }
    expect(gate.observe(quiet)).toBe(false);
  });

  it("invalidates delayed STT calibration after a sustained original-input background change", () => {
    const gate = createLiveSpeechGate(config);
    const noise = { enhancedRms: 0.001, originalRms: 0.01, speechProbability: 0.1, gainDb: 0 };
    gate.observe(noise);
    const observation = gate.captureObservation();
    for (let i = 0; i < 50; i++) gate.observe({ ...noise, originalRms: 0.04 });
    expect(gate.captureObservation().environment).toBe(observation.environment + 1);
    gate.acceptRecognizedSpeech({
      observation,
      speechRms: 0.008,
      speechFrames: 20,
      speechDurationMs: 700,
      segmentCount: 1,
    });
    expect(gate.observe({ enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 })).toBe(false);
  });

  it("ignores old and duplicate feedback instead of ratcheting sensitivity", () => {
    const gate = createLiveSpeechGate(config);
    const feedback = {
      observation: gate.captureObservation(),
      speechRms: 0.005,
      speechFrames: 20,
      speechDurationMs: 700,
      segmentCount: 1,
    };
    for (let i = 0; i < 100; i++) gate.acceptRecognizedSpeech(feedback);
    expect(gate.observe({ enhancedRms: 0.006, speechProbability: 0.9, gainDb: 0 })).toBe(false);
    for (let i = 0; i < 4_000; i++) {
      gate.observe({ enhancedRms: 0.001, speechProbability: 0.1, gainDb: 0 });
    }
    gate.acceptRecognizedSpeech(feedback);
    expect(gate.observe({ enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 })).toBe(false);
  });

  it("requires a continuous background change in the same direction", () => {
    const gate = createLiveSpeechGate(config);
    const noise = { enhancedRms: 0.001, originalRms: 0.01, speechProbability: 0.1, gainDb: 0 };
    gate.observe(noise);
    for (let i = 0; i < 200; i++) {
      gate.observe({ ...noise, originalRms: i % 2 ? 0.001 : 0.1 });
    }
    expect(gate.captureObservation().environment).toBe(0);
    for (let i = 0; i < 49; i++) gate.observe({ ...noise, originalRms: 0.1 });
    gate.observe({ ...noise, originalRms: 0 });
    for (let i = 0; i < 49; i++) gate.observe({ ...noise, originalRms: 0.1 });
    expect(gate.captureObservation().environment).toBe(0);
    gate.observe({ ...noise, originalRms: 0.1 });
    expect(gate.captureObservation().environment).toBe(1);
  });

  it("does not train ambiguous energy into background or discard eligible capture", () => {
    const gate = createLiveSpeechGate(config);
    const quiet = { enhancedRms: 0.001, originalRms: 0.002, speechProbability: 0.1, gainDb: 0 };
    for (let i = 0; i < 100; i++) gate.observe(quiet);
    const observation = gate.captureObservation();
    for (let i = 0; i < 500; i++) {
      gate.observe({ ...quiet, enhancedRms: 0.1, originalRms: 0.2, speechProbability: 0.57 });
    }
    expect(gate.captureObservation().environment).toBe(observation.environment);
    expect(gate.observe({ enhancedRms: 0.009, speechProbability: 0.7, gainDb: 0 })).toBe(true);
    gate.acceptRecognizedSpeech({
      observation: gate.captureObservation(),
      speechRms: 0.008, speechFrames: 20, speechDurationMs: 700, segmentCount: 1,
    });
    expect(gate.observe({ enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 })).toBe(false);
    gate.acceptRecognizedSpeech({
      observation: gate.captureObservation(),
      speechRms: 0.008, speechFrames: 20, speechDurationMs: 700, segmentCount: 1,
    });
    expect(gate.observe({ enhancedRms: 0.0069, speechProbability: 0.9, gainDb: 0 })).toBe(true);
  });

  it("does not learn mute zeros as a quieter room or one impact as a changed source", () => {
    const gate = createLiveSpeechGate(config);
    for (let i = 0; i < 200; i++) {
      gate.observe({ enhancedRms: 0.1, originalRms: 0.1, speechProbability: 0.1, gainDb: 0 });
    }
    const original = gate.captureObservation().environment;
    for (let i = 0; i < 500; i++) {
      gate.observe({ enhancedRms: 0, originalRms: 0, speechProbability: 0.1, gainDb: 0 });
    }
    gate.observe({ enhancedRms: 0.2, originalRms: 0.8, speechProbability: 0.1, gainDb: 0 });
    gate.observe({ enhancedRms: 0.1, originalRms: 0.1, speechProbability: 0.1, gainDb: 0 });
    expect(gate.captureObservation().environment).toBe(original);
    expect(
      gate.observe({ enhancedRms: 0.06, originalRms: 0.1, speechProbability: 0.95, gainDb: 0 }),
    ).toBe(false);
  });
});
