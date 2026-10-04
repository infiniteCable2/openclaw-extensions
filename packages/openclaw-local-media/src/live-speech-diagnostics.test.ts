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
    expect(diagnostics.snapshot()).toEqual(
      expect.objectContaining({
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
        uncertainProbabilityGainFrames: 1,
        uncertainProbabilityMeanGainDb: 6,
        uncertainProbabilityMinGainDb: 6,
        uncertainProbabilityMaxGainDb: 6,
        controlFrames20Ms: 0,
        controlCleanRms: null,
      }),
    );
  });

  it("aggregates aligned numeric control evidence without storing frame histories", () => {
    const diagnostics = createLiveSpeechDiagnostics();
    const control = {
      cleanRms: 0.1,
      nativeGainDb: 6,
      minimumCeilingDb: -6,
      maximumCeilingDb: -5,
      speechFrames: 1,
      uncertainFrames: 1,
      nonspeechFrames: 0,
      holdFrames: 1,
      attenuateFrames: 1,
      recoverFrames: 0,
      clippedFrames: 1,
      mutedFrames: 0,
    };
    diagnostics.observe({ speechProbability: 0.5, gainDb: -5, originalRms: 0.2, control });
    diagnostics.observe({
      speechProbability: 0.9,
      gainDb: -4,
      originalRms: 0.4,
      control: {
        ...control,
        cleanRms: 0.2,
        nativeGainDb: 3,
        minimumCeilingDb: -5,
        maximumCeilingDb: -4,
        speechFrames: 2,
        uncertainFrames: 0,
        holdFrames: 0,
        attenuateFrames: 0,
        recoverFrames: 2,
        clippedFrames: 0,
      },
    });
    expect(diagnostics.snapshot()).toEqual(
      expect.objectContaining({
        controlFrames20Ms: 2,
        controlReceivedFrames20Ms: 2,
        controlReceivedRms: Math.sqrt(0.1),
        controlCleanRms: Math.sqrt(0.025),
        controlNativeMeanGainDb: 4.5,
        controlNativeMinGainDb: 3,
        controlNativeMaxGainDb: 6,
        controlMinimumCeilingDb: -6,
        controlMaximumCeilingDb: -4,
        controlSpeechFrames10Ms: 3,
        controlUncertainFrames10Ms: 1,
        controlNonspeechFrames10Ms: 0,
        controlCeilingHoldFrames10Ms: 1,
        controlCeilingAttenuateFrames10Ms: 1,
        controlCeilingRecoverFrames10Ms: 2,
        controlInputClippedFrames10Ms: 1,
        controlInputMutedFrames10Ms: 0,
      }),
    );
    expect(
      Object.values(diagnostics.snapshot()).every(
        (value) => value === null || typeof value === "number",
      ),
    ).toBe(true);
    expect(createLiveSpeechDiagnostics().snapshot().controlFrames20Ms).toBe(0);
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
    expect(diagnostics.snapshot()).toEqual(
      expect.objectContaining({
        highProbabilityGainFrames: 1,
        lowProbabilityGainFrames: 99,
        longestLowProbabilityStreakMs: 1_000,
        maxLowProbabilityStreakGainRiseDb: 0,
      }),
    );
  });
});
