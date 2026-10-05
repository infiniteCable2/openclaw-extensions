"""One native WebRTC AGC2 owner for agent-directed speech.

The noise suppressor supplies pre-gain speech evidence to AGC2. AGC2 owns
speech-level learning, noise-aware gain, saturation protection and limiting;
this module does not apply a second gain feedback loop.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

SAMPLE_RATE = 16_000
FRAME_SAMPLES = SAMPLE_RATE // 100
HIGH_PROBABILITY = 0.95
LOW_PROBABILITY = 0.3


@dataclass(frozen=True, slots=True)
class SpeechControlConfig:
    max_gain_db: float = 12.0
    headroom_db: float = 8.0
    max_gain_change_db_per_second: float = 6.0
    max_output_noise_level_dbfs: float = -50.0

    def __post_init__(self) -> None:
        for value, minimum, maximum in (
            (self.max_gain_db, 0, 15),
            (self.headroom_db, 3, 20),
            (self.max_gain_change_db_per_second, 1, 12),
            (self.max_output_noise_level_dbfs, -80, -30),
        ):
            if not math.isfinite(value) or not minimum <= value <= maximum:
                raise ValueError("speech control configuration is outside its bounds")


class SpeechProcessor:
    """Per-source 10-ms native APM state exposed as 20-ms live frames."""

    def __init__(self, config: SpeechControlConfig) -> None:
        from pywebrtc_audio import AudioProcessor, GainController

        self._cleaner = AudioProcessor(
            sample_rate=SAMPLE_RATE,
            noise_suppression=True,
            high_pass_filter=True,
            auto_gain_control=False,
            echo_cancellation=False,
            ns_level=1,
        )
        self._gain = GainController(
            sample_rate=SAMPLE_RATE,
            fixed_gain_db=0.0,
            adaptive_digital=True,
            max_gain_db=config.max_gain_db,
            headroom_db=config.headroom_db,
            max_gain_change_db_per_second=config.max_gain_change_db_per_second,
            max_output_noise_level_dbfs=config.max_output_noise_level_dbfs,
        )
        # The pinned binding starts at 15 dB even when max_gain_db is lower.
        # Settle only its gain stage using silence, without consuming user PCM
        # or priming the noise suppressor with invented ambient sound.
        startup_frames = math.ceil(
            (15.0 - config.max_gain_db) / (config.max_gain_change_db_per_second / 100)
        ) + 1
        silence = np.zeros(FRAME_SAMPLES, dtype=np.float32)
        for _ in range(startup_frames):
            self._gain.process(silence, speech_probability=0.0)
        self.speech_probability = 0.0
        self.gain_db = 0.0
        self.control: dict[str, float] = {}

    def process(self, audio: np.ndarray) -> np.ndarray:
        if audio.ndim != 1 or audio.dtype != np.float32 or not np.isfinite(audio).all():
            raise ValueError("speech input must be finite mono float32 PCM")
        if audio.size == 0:
            self.speech_probability = self.gain_db = 0.0
            self.control = {}
            return audio.copy()
        output = np.empty_like(audio)
        clean_energy = 0.0
        output_energy = 0.0
        counts = dict.fromkeys(("highProbability", "midProbability", "lowProbability",
                                "clipped", "muted"), 0)
        for start in range(0, audio.size, FRAME_SAMPLES):
            valid = min(FRAME_SAMPLES, audio.size - start)
            frame = np.ascontiguousarray(audio[start : start + valid])
            if valid != FRAME_SAMPLES:
                frame = np.pad(frame, (0, FRAME_SAMPLES - valid))
            clean = self._cleaner.process(frame)
            probability = float(self._cleaner.speech_probability)
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError("speech processor returned invalid probability")
            # A zero received frame is not speech evidence. Otherwise preserve
            # the complete probability, including uncertain values, for native
            # AGC2 to apply its own confidence and adjacent-frame rules.
            muted = not np.any(frame)
            evidence = 0.0 if muted else probability
            enhanced = self._gain.process(clean, speech_probability=evidence)
            if enhanced.shape != frame.shape or not np.isfinite(enhanced).all():
                raise ValueError("speech processor returned invalid PCM")
            output[start : start + valid] = enhanced[:valid]
            clean_energy += float(np.sum(np.square(clean[:valid], dtype=np.float64)))
            output_energy += float(np.sum(np.square(enhanced[:valid], dtype=np.float64)))
            bucket = ("highProbability" if evidence >= HIGH_PROBABILITY else
                      "midProbability" if evidence >= LOW_PROBABILITY else "lowProbability")
            counts[bucket] += 1
            counts["clipped"] += int(float(np.mean(np.abs(frame) >= 0.999)) >= 0.01)
            counts["muted"] += int(muted)
            # Keep the binding's most recent 10-ms probability semantics.
            self.speech_probability = evidence
        # Aligned 20-ms energy ratio includes native limiter action. It is not
        # the original-microphone gain or an inverse of noise suppression.
        self.gain_db = (
            10 * math.log10(output_energy / clean_energy)
            if output_energy > 0 and clean_energy > 0 else 0.0
        )
        self.control = {
            "cleanRms": math.sqrt(clean_energy / audio.size),
            **{f"{name}Frames": count for name, count in counts.items()},
        }
        return output


def create_speech_processor(config: SpeechControlConfig | None = None) -> SpeechProcessor:
    return SpeechProcessor(config or SpeechControlConfig())
