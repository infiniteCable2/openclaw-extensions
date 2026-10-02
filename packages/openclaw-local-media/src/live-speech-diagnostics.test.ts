import { describe, expect, it } from "vitest";
import { createLiveSpeechDiagnostics } from "./live-speech-diagnostics.js";

describe("live speech diagnostics", () => {
  it("separates high and low probability gain without labeling either as ground truth", () => {
    const diagnostics = createLiveSpeechDiagnostics();
    diagnostics.observe({ speechProbability: 0.9, gainDb: 3 });
    diagnostics.observe({ speechProbability: 0.9, gainDb: 5 });
    diagnostics.observe({ speechProbability: 0.5, gainDb: 6 });
    for (let index = 0; index < 50; index += 1) {
      diagnostics.observe({ speechProbability: 0.1, gainDb: 4 + index / 10 });
    }
    expect(diagnostics.snapshot()).toEqual({
      highProbabilityGainFrames: 2,
      highProbabilityMeanGainDb: 4,
      highProbabilityMinGainDb: 3,
      highProbabilityMaxGainDb: 5,
      lowProbabilityGainFrames: 50,
      lowProbabilityMeanGainDb: expect.closeTo(6.45),
      lowProbabilityMinGainDb: 4,
      lowProbabilityMaxGainDb: 8.9,
      longestLowProbabilityStreakMs: 1_000,
      maxLowProbabilityStreakGainRiseDb: expect.closeTo(4.9),
    });
  });

  it("does not claim a gain rise across separate low-probability intervals", () => {
    const diagnostics = createLiveSpeechDiagnostics();
    for (let index = 0; index < 50; index += 1) {
      diagnostics.observe({ speechProbability: 0.1, gainDb: 5 });
    }
    diagnostics.observe({ speechProbability: 0.9, gainDb: 8 });
    for (let index = 0; index < 49; index += 1) {
      diagnostics.observe({ speechProbability: 0.1, gainDb: 9 });
    }
    expect(diagnostics.snapshot()).toEqual(expect.objectContaining({
      highProbabilityGainFrames: 1,
      lowProbabilityGainFrames: 99,
      longestLowProbabilityStreakMs: 1_000,
      maxLowProbabilityStreakGainRiseDb: 0,
    }));
  });
});
