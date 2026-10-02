export type LiveSpeechEvidence = {
  enhancedRms: number;
  speechProbability: number;
  gainDb: number;
};

/** Per-call noise estimate in the APM input-gain reference, never shared between callers. */
export function createLiveSpeechGate(config: {
  speechRmsThreshold: number;
  speechProbabilityThreshold: number;
  speechNoiseMarginDb: number;
}) {
  const minimumOutputRms = config.speechRmsThreshold / 2;
  const noiseMargin = 10 ** (config.speechNoiseMarginDb / 20);
  const confidentSpeechMargin = 10 ** (Math.min(config.speechNoiseMarginDb, 1) / 20);
  let noiseRms = 0.001;
  let learnedMinimumOutputRms = minimumOutputRms;
  return {
    observe(evidence: LiveSpeechEvidence): boolean {
      // APM noise suppression changes the waveform; de-gaining is only a stable
      // reference for comparing nearby frames, not a reconstruction of raw audio.
      const referenceRms = evidence.enhancedRms / 10 ** (evidence.gainDb / 20);
      if (
        evidence.speechProbability < config.speechProbabilityThreshold - 0.05 ||
        referenceRms < noiseRms * 1.2
      ) {
        const rate = referenceRms > noiseRms ? 0.04 : 0.15;
        noiseRms = Math.max(0.0005, noiseRms + rate * (referenceRms - noiseRms));
      }
      return (
        evidence.speechProbability >= config.speechProbabilityThreshold &&
        evidence.enhancedRms >= learnedMinimumOutputRms &&
        (referenceRms >= noiseRms * noiseMargin ||
          (evidence.speechProbability >= 0.85 &&
            referenceRms >= noiseRms * confidentSpeechMargin))
      );
    },
    acceptRecognizedSpeech(evidence: {
      speechRms: number;
      speechFrames: number;
      speechDurationMs: number | null;
      segmentCount: number;
    }): void {
      // An STT result can corroborate earlier high-probability speech. It may
      // only relax the energy guard a little; probability and noise margin stay
      // mandatory. No individual decoder score is treated as confidence.
      if (
        evidence.speechDurationMs === null ||
        !Number.isSafeInteger(evidence.speechDurationMs) ||
        evidence.speechDurationMs < 300 ||
        !Number.isInteger(evidence.segmentCount) ||
        evidence.segmentCount < 1 ||
        evidence.segmentCount > 2_147_483_647 ||
        !Number.isSafeInteger(evidence.speechFrames) ||
        evidence.speechFrames < 10 ||
        !Number.isFinite(evidence.speechRms) ||
        evidence.speechRms <= 0 ||
        evidence.speechRms > 1
      ) return;
      const desired = Math.max(
        minimumOutputRms * 0.6,
        Math.min(minimumOutputRms, evidence.speechRms * 0.4),
      );
      if (desired >= learnedMinimumOutputRms) return;
      learnedMinimumOutputRms = Math.max(
        minimumOutputRms * 0.6,
        learnedMinimumOutputRms - Math.min(
          minimumOutputRms * 0.08,
          (learnedMinimumOutputRms - desired) * 0.2,
        ),
      );
    },
  };
}
