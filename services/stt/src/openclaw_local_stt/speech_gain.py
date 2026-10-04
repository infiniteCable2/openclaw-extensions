"""A feed-forward signed ceiling for the native speech gain proposal.

Only pre-gain speech evidence updates the ceiling; final output is never fed
back into a competing AGC. The native limiter is preserved and this selector
can only attenuate its output. State belongs to one source and advances at 10 ms.
"""
from __future__ import annotations

import math

import numpy as np


class SpeechGainSupervisor:
    def __init__(self, *, max_gain_db: float, max_attenuation_db: float,
                 speech_ceiling_dbfs: float, attenuation_db_per_second: float,
                 recovery_db_per_second: float) -> None:
        self._maximum = max_gain_db
        self._minimum = -max_attenuation_db
        self._target = speech_ceiling_dbfs
        self._attack = attenuation_db_per_second * 0.01
        self._release = recovery_db_per_second * 0.01
        self._ceiling = max_gain_db
        self._speech_power: float | None = None
        self._extra_db = 0.0
        self._trusted = False
        self._untrusted_frames = 0
        self.state = "uncertain"
        self.ceiling_action = "hold"

    @property
    def ceiling_db(self) -> float:
        """Read-only supervisory target, not actual output gain or an SNR value."""
        return self._ceiling

    def observe(self, original: np.ndarray, clean: np.ndarray, probability: float) -> float:
        """Return gain-estimation probability, not a replacement speech detector."""
        nonzero = bool(np.any(original))
        clipped = float(np.mean(np.abs(original) >= 0.999)) >= 0.01
        self._trusted = nonzero and not clipped and probability >= 0.85
        self.state = ("speech" if self._trusted else "uncertain"
                      if nonzero and (probability >= 0.3 or clipped) else "nonspeech")
        if self._trusted:
            power = float(np.mean(np.square(clean, dtype=np.float64)))
            if self._speech_power is None or self._untrusted_frames >= 100:
                self._speech_power = power
            else:
                # Follow sustained loud speech faster than syllabic level dips.
                tau = 0.15 if power > self._speech_power else 0.4
                self._speech_power += (1 - math.exp(-0.01 / tau)) * (power - self._speech_power)
            self._untrusted_frames = 0
        else:
            self._untrusted_frames = min(100, self._untrusted_frames + 1)
        # Native AGC continues its noise estimator and limiter, but receives no
        # permission to increase gain from ambiguous, muted or clipped input.
        return probability if self._trusted else 0.0

    def select(self, clean: np.ndarray, native: np.ndarray) -> np.ndarray:
        previous_ceiling = self._ceiling
        clean_energy = float(np.sum(np.square(clean, dtype=np.float64)))
        native_energy = float(np.sum(np.square(native, dtype=np.float64)))
        native_gain = (10 * math.log10(native_energy / clean_energy)
                       if clean_energy > 0 and native_energy > 0 else 0.0)
        if self._trusted and self._speech_power is not None:
            level = 10 * math.log10(max(self._speech_power, 1e-12))
            desired = max(self._minimum, min(self._maximum, self._target - level))
            if desired < self._ceiling:
                # Do not wait for unused positive headroom to ramp down first.
                start = min(self._ceiling, max(self._minimum, native_gain))
                self._ceiling = max(desired, start - self._attack)
            else:
                self._ceiling = min(desired, self._ceiling + self._release)
        if not self._trusted and self._untrusted_frames >= 100 and self._ceiling < 0:
            self._ceiling = min(0.0, self._ceiling + self._release)
        self.ceiling_action = ("attenuate" if self._ceiling < previous_ceiling else
                               "recover" if self._ceiling > previous_ceiling else "hold")
        extra_db = min(0.0, self._ceiling - native_gain)
        # Brief uncertainty holds attenuation. After one second, a negative net
        # gain may recover toward unity, never into a new boost. Otherwise loud
        # speech followed by soft speech could remain attenuated indefinitely.
        if not self._trusted:
            permitted = self._extra_db
            if self._untrusted_frames >= 100:
                neutral = min(0.0, min(0.0, self._ceiling) - native_gain)
                permitted = max(permitted, neutral)
            extra_db = min(extra_db, permitted)
        extra_db = min(extra_db, self._extra_db + self._release)
        # A falling native proposal must not compound held attenuation beyond
        # our signed floor. Native limiter reductions below that floor remain
        # untouched: this stage never amplifies the native result.
        minimum_extra = min(0.0, self._minimum - native_gain)
        extra_db = max(minimum_extra, extra_db)
        # Smooth at sample resolution, not with discontinuous frame multipliers.
        envelope = np.linspace(max(minimum_extra, self._extra_db), extra_db, len(native) + 1)[1:]
        result = native * np.power(10.0, envelope / 20).astype(np.float32)
        self._extra_db = extra_db
        return result
