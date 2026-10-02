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
  bucket.frames += 1;
  bucket.meanDb += (gainDb - bucket.meanDb) / bucket.frames;
  bucket.minDb = Math.min(bucket.minDb ?? gainDb, gainDb);
  bucket.maxDb = Math.max(bucket.maxDb ?? gainDb, gainDb);
}

/** Bounded, content-free per-call evidence; probability is not a ground-truth speech label. */
export function createLiveSpeechDiagnostics() {
  const high = createGainBucket();
  const low = createGainBucket();
  let lowStreakFrames = 0;
  let lowStreakStartGainDb = 0;
  let longestLowStreakFrames = 0;
  let maxLowStreakGainRiseDb = 0;

  return {
    observe(frame: { speechProbability: number; gainDb: number }): void {
      if (frame.speechProbability >= HIGH_PROBABILITY) {
        addGain(high, frame.gainDb);
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
      };
    },
  };
}
