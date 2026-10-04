export type LiveSpeechEvidence = {
  enhancedRms: number;
  speechProbability: number;
  gainDb: number;
  /** Aligned received signal, before our APM; not the hardware microphone signal. */
  originalRms?: number;
  originalPeak?: number;
};

export type SpeechObservation = { frame: number; environment: number };

// The gate receives one aligned 20-ms frame. Audio time, not wall-clock sleeps,
// drives recovery identically for realtime and faster-than-realtime replays.
const FEEDBACK_MAX_AGE_FRAMES = 1_500;
const RECOVERY_RATE = 1 - Math.exp(-0.02 / 5);

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
  let frame = 0;
  let environment = 0;
  let originalNoiseRms: number | undefined;
  let changedNoiseFrames = 0;
  let changedNoiseDirection = 0;
  let lastFeedbackFrame = -FEEDBACK_MAX_AGE_FRAMES;
  let calibrationBlocked = false;
  return {
    captureObservation(): SpeechObservation {
      return { frame, environment };
    },
    observe(evidence: LiveSpeechEvidence): boolean {
      frame += 1;
      if (
        !Number.isFinite(evidence.enhancedRms) ||
        evidence.enhancedRms < 0 ||
        !Number.isFinite(evidence.speechProbability) ||
        evidence.speechProbability < 0 ||
        evidence.speechProbability > 1 ||
        !Number.isFinite(evidence.gainDb) ||
        (evidence.originalRms !== undefined &&
          (!Number.isFinite(evidence.originalRms) || evidence.originalRms < 0)) ||
        (evidence.originalPeak !== undefined &&
          (!Number.isFinite(evidence.originalPeak) || evidence.originalPeak < 0))
      ) {
        changedNoiseFrames = 0;
        calibrationBlocked = true;
        return false;
      }
      // Mute/transport zeros are not quieter room noise. Preserve estimates.
      if (evidence.originalRms === 0) {
        changedNoiseFrames = 0;
        return false;
      }
      // Ambiguous probability is neither reliable background nor corroborated
      // speech. Keep capture eligibility unchanged; freeze only calibration.
      calibrationBlocked =
        evidence.speechProbability >= config.speechProbabilityThreshold - 0.05 &&
        evidence.speechProbability < 0.85;
      // APM noise suppression changes the waveform; de-gaining is only a stable
      // reference for comparing nearby frames, not a reconstruction of raw audio.
      const referenceRms = evidence.enhancedRms / 10 ** (evidence.gainDb / 20);
      if (!Number.isFinite(referenceRms)) return false;
      // Freeze for plausible speech, including speech near the noise floor.
      // Otherwise a sustained quiet word trains itself into the noise estimate
      // and disappears before minimum speech duration can be reached.
      if (evidence.speechProbability < config.speechProbabilityThreshold - 0.05) {
        if (evidence.originalRms !== undefined) {
          const receivedNoise = Math.max(0.00001, evidence.originalRms);
          originalNoiseRms ??= receivedNoise;
          const differenceDb = 20 * Math.log10(receivedNoise / originalNoiseRms);
          if (Math.abs(differenceDb) >= 6) {
            const direction = Math.sign(differenceDb);
            changedNoiseFrames = direction === changedNoiseDirection ? changedNoiseFrames + 1 : 1;
            changedNoiseDirection = direction;
            if (changedNoiseFrames >= 50) {
              // A sustained source/background change invalidates old STT
              // calibration, not transcripts or the native AGC's state.
              environment += 1;
              originalNoiseRms = receivedNoise;
              learnedMinimumOutputRms = minimumOutputRms;
              lastFeedbackFrame = -FEEDBACK_MAX_AGE_FRAMES;
              changedNoiseFrames = 0;
            }
          } else {
            changedNoiseFrames = 0;
            originalNoiseRms += 0.02 * (receivedNoise - originalNoiseRms);
          }
        } else {
          changedNoiseFrames = 0;
        }
        const rate = referenceRms > noiseRms ? 0.04 : 0.15;
        noiseRms = Math.max(0.0005, noiseRms + rate * (referenceRms - noiseRms));
        if (frame - lastFeedbackFrame > FEEDBACK_MAX_AGE_FRAMES) {
          learnedMinimumOutputRms += RECOVERY_RATE * (minimumOutputRms - learnedMinimumOutputRms);
        }
      } else {
        changedNoiseFrames = 0;
      }
      return (
        evidence.originalRms !== 0 &&
        evidence.speechProbability >= config.speechProbabilityThreshold &&
        evidence.enhancedRms >= learnedMinimumOutputRms &&
        (referenceRms >= noiseRms * noiseMargin ||
          (evidence.speechProbability >= 0.85 && referenceRms >= noiseRms * confidentSpeechMargin))
      );
    },
    acceptRecognizedSpeech(evidence: {
      observation: SpeechObservation;
      speechRms: number;
      speechFrames: number;
      speechDurationMs: number | null;
      segmentCount: number;
    }): void {
      // An STT result can corroborate earlier high-probability speech. It may
      // only relax the energy guard a little; probability and noise margin stay
      // mandatory. No individual decoder score is treated as confidence.
      if (
        calibrationBlocked ||
        evidence.observation.environment !== environment ||
        !Number.isSafeInteger(evidence.observation.frame) ||
        evidence.observation.frame < 0 ||
        evidence.observation.frame > frame ||
        frame - evidence.observation.frame > FEEDBACK_MAX_AGE_FRAMES ||
        evidence.observation.frame <= lastFeedbackFrame ||
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
      )
        return;
      lastFeedbackFrame = evidence.observation.frame;
      const desired = Math.max(
        minimumOutputRms * 0.6,
        Math.min(minimumOutputRms, evidence.speechRms * 0.4),
      );
      if (desired >= learnedMinimumOutputRms) return;
      learnedMinimumOutputRms = Math.max(
        minimumOutputRms * 0.6,
        learnedMinimumOutputRms -
          Math.min(minimumOutputRms * 0.08, (learnedMinimumOutputRms - desired) * 0.2),
      );
    },
  };
}
