"""Coordinated native speech gain and a signed ceiling for live/uploaded speech.

HPF/NS and AGC are separate public WebRTC bindings, not competing AGCs. Passing
the NS probability explicitly avoids a second VAD and gives both estimators
the same 10-ms observation. This does not claim a measurable clean-source SNR.
"""

from __future__ import annotations


import math
from dataclasses import dataclass

import numpy as np

from .speech_gain import SpeechGainSupervisor

SAMPLE_RATE = 16_000
FRAME_SAMPLES = SAMPLE_RATE // 100


@dataclass(frozen=True, slots=True)
class SpeechControlConfig:
    max_gain_db: float = 12.0
    headroom_db: float = 8.0
    # Native slew is symmetric: slowing it also delays recovery from loud noise.
    max_gain_change_db_per_second: float = 6.0
    max_output_noise_level_dbfs: float = -50.0
    speech_ceiling_dbfs: float = -18.0
    max_attenuation_db: float = 12.0
    attenuation_db_per_second: float = 24.0
    recovery_db_per_second: float = 6.0

    def __post_init__(self) -> None:
        for value, minimum, maximum in (
            (self.max_gain_db, 0, 15),
            (self.headroom_db, 3, 20),
            (self.max_gain_change_db_per_second, 1, 12),
            (self.max_output_noise_level_dbfs, -80, -30),
            (self.speech_ceiling_dbfs, -24, -12),
            (self.max_attenuation_db, 0, 18),
            (self.attenuation_db_per_second, 6, 48),
            (self.recovery_db_per_second, 1, 12),
        ):
            if not math.isfinite(value) or not minimum <= value <= maximum:
                raise ValueError("speech control configuration is outside its bounds")


class SpeechProcessor:
    """Per-source state; native AGC2 proposes boost, a feed-forward ceiling limits it.

    Live callers supply whole 20-ms frames; file callers supply whole frames
    except the final tail, which is zero-padded once and truncated on return.
    No audio is held back and no wall-clock wait is introduced.
    """

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
        # pywebrtc-audio 0.2.0 fixes initial_gain_db at 15, even below a lower
        # configured maximum. Advance only the gain stage through silent frames
        # until its bounded native decrease reaches our ceiling. Do not prime
        # NS with artificial noise, modify the dependency, or discard user PCM.
        startup_frames = math.ceil(
            (15.0 - config.max_gain_db) / (config.max_gain_change_db_per_second / 100)
        ) + 1
        silence = np.zeros(FRAME_SAMPLES, dtype=np.float32)
        for _ in range(startup_frames):
            self._gain.process(silence, speech_probability=0.0)
        self.speech_probability = 0.0
        self.gain_db = 0.0
        self.control: dict[str, float] = {}
        self._supervisor = SpeechGainSupervisor(
            max_gain_db=config.max_gain_db,
            max_attenuation_db=config.max_attenuation_db,
            speech_ceiling_dbfs=config.speech_ceiling_dbfs,
            attenuation_db_per_second=config.attenuation_db_per_second,
            recovery_db_per_second=config.recovery_db_per_second,
        )

    def process(self, audio: np.ndarray) -> np.ndarray:
        if audio.ndim != 1 or audio.dtype != np.float32 or not np.isfinite(audio).all():
            raise ValueError("speech input must be finite mono float32 PCM")
        if audio.size == 0:
            self.speech_probability = self.gain_db = 0.0
            self.control = {}
            return audio.copy()
        output = np.empty_like(audio)
        pre_gain_energy = 0.0
        output_energy = 0.0
        native_energy = 0.0
        counts = dict.fromkeys(("speech", "uncertain", "nonspeech", "hold", "attenuate",
                                "recover", "clipped", "muted"), 0)
        minimum_ceiling = math.inf
        maximum_ceiling = -math.inf
        for start in range(0, audio.size, FRAME_SAMPLES):
            valid = min(FRAME_SAMPLES, audio.size - start)
            frame = np.ascontiguousarray(audio[start : start + valid])
            if valid != FRAME_SAMPLES:
                frame = np.pad(frame, (0, FRAME_SAMPLES - valid))
            clean = self._cleaner.process(frame)
            probability = float(self._cleaner.speech_probability)
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError("speech processor returned invalid probability")
            # A zero received frame is not evidence permitting an increase.
            # Continue processing so filters and the native limiter can settle.
            control_probability = self._supervisor.observe(frame, clean, probability)
            enhanced = self._gain.process(clean, speech_probability=control_probability)
            if enhanced.shape != frame.shape or not np.isfinite(enhanced).all():
                raise ValueError("speech processor returned invalid PCM")
            native_energy += float(np.sum(np.square(enhanced[:valid], dtype=np.float64)))
            enhanced = self._supervisor.select(clean, enhanced)
            counts[self._supervisor.state] += 1
            counts[self._supervisor.ceiling_action] += 1
            counts["clipped"] += int(float(np.mean(np.abs(frame) >= 0.999)) >= 0.01)
            counts["muted"] += int(not np.any(frame))
            minimum_ceiling = min(minimum_ceiling, self._supervisor.ceiling_db)
            maximum_ceiling = max(maximum_ceiling, self._supervisor.ceiling_db)
            output[start : start + valid] = enhanced[:valid]
            pre_gain_energy += float(np.sum(np.square(clean[:valid], dtype=np.float64)))
            output_energy += float(np.sum(np.square(enhanced[:valid], dtype=np.float64)))
            # Preserve the binding's most-recent-frame probability semantics.
            # Averaging across a 20-ms envelope delays weak word onsets; file
            # callers do not consume a whole-recording probability anyway.
            # Capture/STT still see the detector's evidence, not the more
            # conservative gain-learning permission. Uncertainty is not a mute.
            self.speech_probability = probability if np.any(frame) else 0.0
        # Measure the actual block transfer, including native limiter action.
        # The binding's last-10ms peak ratio can be stale or misaligned with a
        # 20-ms consumer. This ratio is not inversion of noise suppression.
        self.gain_db = (
            10 * math.log10(output_energy / pre_gain_energy)
            if output_energy > 0 and pre_gain_energy > 0 else 0.0
        )
        # Numeric, bounded block observations only; never feed telemetry back
        # into processing or retain audio/per-frame history for diagnostics.
        self.control = {
            "cleanRms": math.sqrt(pre_gain_energy / audio.size),
            "nativeGainDb": (10 * math.log10(native_energy / pre_gain_energy)
                             if native_energy > 0 and pre_gain_energy > 0 else 0.0),
            "minimumCeilingDb": minimum_ceiling,
            "maximumCeilingDb": maximum_ceiling,
            **{f"{name}Frames": count for name, count in counts.items()},
        }
        return output


def create_speech_processor(config: SpeechControlConfig | None = None) -> SpeechProcessor:
    return SpeechProcessor(config or SpeechControlConfig())
