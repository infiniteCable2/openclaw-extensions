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
  let noiseRms = 0.001;
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
        evidence.enhancedRms >= minimumOutputRms &&
        (referenceRms >= noiseRms * noiseMargin || evidence.speechProbability >= 0.85)
      );
    },
  };
}
