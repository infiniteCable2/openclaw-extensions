import type { LiveSpeechControl } from "./live-speech-processor.js";

const FRAME_MS = 20;
const HIGH_PROBABILITY = 0.85;
const LOW_PROBABILITY = 0.3;
const MIN_LOW_PROBABILITY_STREAK_MS = 1_000;

type GainBucket = {
  frames: number;
  meanDb: number;
  minDb: number | null;
  maxDb: number | null;
};

function createGainBucket(): GainBucket {
  return { frames: 0, meanDb: 0, minDb: null, maxDb: null };
}

function addGain(bucket: GainBucket, gainDb: number): void {
  bucket.frames = Math.min(Number.MAX_SAFE_INTEGER, bucket.frames + 1);
  bucket.meanDb += (gainDb - bucket.meanDb) / bucket.frames;
  bucket.minDb = Math.min(bucket.minDb ?? gainDb, gainDb);
  bucket.maxDb = Math.max(bucket.maxDb ?? gainDb, gainDb);
}

/** Bounded, content-free per-call evidence; probability is not a ground-truth speech label. */
export function createLiveSpeechDiagnostics() {
  const high = createGainBucket();
  const low = createGainBucket();
  const uncertain = createGainBucket();
  const native = createGainBucket();
  let cleanPowerMean = 0;
  let receivedFrames = 0;
  let receivedPowerMean = 0;
  let minimumCeilingDb: number | null = null;
  let maximumCeilingDb: number | null = null;
  const controlFrames = {
    speech: 0,
    uncertain: 0,
    nonspeech: 0,
    hold: 0,
    attenuate: 0,
    recover: 0,
    clipped: 0,
    muted: 0,
  };
  let lowStreakFrames = 0;
  let lowStreakStartGainDb = 0;
  let longestLowStreakFrames = 0;
  let maxLowStreakGainRiseDb = 0;

  return {
    observe(frame: {
      speechProbability: number;
      gainDb: number;
      originalRms?: number;
      control?: LiveSpeechControl;
    }): void {
      if (frame.control) {
        const control = frame.control;
        addGain(native, control.nativeGainDb);
        cleanPowerMean += (control.cleanRms ** 2 - cleanPowerMean) / native.frames;
        if (
          frame.originalRms !== undefined &&
          Number.isFinite(frame.originalRms) &&
          frame.originalRms >= 0 &&
          frame.originalRms <= 1
        ) {
          receivedFrames = Math.min(Number.MAX_SAFE_INTEGER, receivedFrames + 1);
          receivedPowerMean += (frame.originalRms ** 2 - receivedPowerMean) / receivedFrames;
        }
        minimumCeilingDb = Math.min(
          minimumCeilingDb ?? control.minimumCeilingDb,
          control.minimumCeilingDb,
        );
        maximumCeilingDb = Math.max(
          maximumCeilingDb ?? control.maximumCeilingDb,
          control.maximumCeilingDb,
        );
        for (const key of Object.keys(controlFrames) as Array<keyof typeof controlFrames>) {
          controlFrames[key] = Math.min(
            Number.MAX_SAFE_INTEGER,
            controlFrames[key] + control[`${key}Frames`],
          );
        }
      }
      if (frame.speechProbability >= HIGH_PROBABILITY) {
        addGain(high, frame.gainDb);
      } else if (frame.speechProbability >= LOW_PROBABILITY) {
        addGain(uncertain, frame.gainDb);
      }
      if (frame.speechProbability < LOW_PROBABILITY) {
        addGain(low, frame.gainDb);
        if (lowStreakFrames === 0) {
          lowStreakStartGainDb = frame.gainDb;
        }
        lowStreakFrames += 1;
        longestLowStreakFrames = Math.max(longestLowStreakFrames, lowStreakFrames);
        if (lowStreakFrames * FRAME_MS >= MIN_LOW_PROBABILITY_STREAK_MS) {
          maxLowStreakGainRiseDb = Math.max(
            maxLowStreakGainRiseDb,
            frame.gainDb - lowStreakStartGainDb,
          );
        }
      } else {
        lowStreakFrames = 0;
      }
    },
    snapshot() {
      return {
        highProbabilityGainFrames: high.frames,
        highProbabilityMeanGainDb: high.frames ? high.meanDb : null,
        highProbabilityMinGainDb: high.minDb,
        highProbabilityMaxGainDb: high.maxDb,
        lowProbabilityGainFrames: low.frames,
        lowProbabilityMeanGainDb: low.frames ? low.meanDb : null,
        lowProbabilityMinGainDb: low.minDb,
        lowProbabilityMaxGainDb: low.maxDb,
        longestLowProbabilityStreakMs: longestLowStreakFrames * FRAME_MS,
        maxLowProbabilityStreakGainRiseDb: maxLowStreakGainRiseDb,
        uncertainProbabilityGainFrames: uncertain.frames,
        uncertainProbabilityMeanGainDb: uncertain.frames ? uncertain.meanDb : null,
        uncertainProbabilityMinGainDb: uncertain.minDb,
        uncertainProbabilityMaxGainDb: uncertain.maxDb,
        controlFrames20Ms: native.frames,
        controlReceivedFrames20Ms: receivedFrames,
        controlReceivedRms: receivedFrames ? Math.sqrt(receivedPowerMean) : null,
        controlCleanRms: native.frames ? Math.sqrt(cleanPowerMean) : null,
        controlNativeMeanGainDb: native.frames ? native.meanDb : null,
        controlNativeMinGainDb: native.minDb,
        controlNativeMaxGainDb: native.maxDb,
        controlMinimumCeilingDb: minimumCeilingDb,
        controlMaximumCeilingDb: maximumCeilingDb,
        controlSpeechFrames10Ms: controlFrames.speech,
        controlUncertainFrames10Ms: controlFrames.uncertain,
        controlNonspeechFrames10Ms: controlFrames.nonspeech,
        controlCeilingHoldFrames10Ms: controlFrames.hold,
        controlCeilingAttenuateFrames10Ms: controlFrames.attenuate,
        controlCeilingRecoverFrames10Ms: controlFrames.recover,
        controlInputClippedFrames10Ms: controlFrames.clipped,
        controlInputMutedFrames10Ms: controlFrames.muted,
      };
    },
  };
}
