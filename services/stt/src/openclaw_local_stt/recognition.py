"""Bounded, backend-neutral recognition observations (not confidence scores)."""

from __future__ import annotations

import math
import re


_SIGNAL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9.]{0,63}\Z")


class RecognitionEvidence:
    """Aggregate allowlisted numeric signals without retaining segment data."""

    def __init__(self) -> None:
        self.segment_count = 0
        self._signals: dict[str, tuple[float, int]] = {}

    def add_segment(self) -> None:
        self.segment_count = min(self.segment_count + 1, 2**31 - 1)

    def add_signal(self, name: str, value: object, *, minimum: float, maximum: float) -> None:
        if not isinstance(name, str) or not _SIGNAL_NAME.fullmatch(name):
            return
        if len(self._signals) >= 8 and name not in self._signals:
            return
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return
        if not minimum <= value <= maximum or not math.isfinite(value):
            return
        total, count = self._signals.get(name, (0.0, 0))
        if count >= 2**31 - 1:
            return
        updated = total + value
        if math.isfinite(updated):
            self._signals[name] = (updated, count + 1)

    def result(self, *, audio_duration_ms: int | None, speech_duration_ms: int | None) -> dict[str, object]:
        return {
            "audioDurationMs": audio_duration_ms,
            "speechDurationMs": speech_duration_ms,
            "segmentCount": self.segment_count,
            "signals": [
                {"name": name, "mean": round(total / count, 6), "samples": count}
                for name, (total, count) in sorted(self._signals.items())
            ],
        }
