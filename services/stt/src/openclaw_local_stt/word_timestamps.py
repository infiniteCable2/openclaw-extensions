"""Bound optional recognizer timing output; never invent alignment or display text."""
from __future__ import annotations

import math
from typing import NotRequired, TypedDict

from .request_lifecycle import ServiceError

MAX_WORDS = 8192
MAX_TIMING_BYTES = 1024 * 1024


class WordTimestamp(TypedDict):
    word: str
    start: float
    end: float
    probability: NotRequired[float]


def timing_number(value: object, *, maximum: float) -> float:
    if (
        isinstance(value, bool) or not isinstance(value, (int, float))
        or not math.isfinite(value) or not 0 <= value <= maximum
    ):
        raise ServiceError(
            "timing_unavailable", "recognizer returned invalid word timing",
            422, retryable=False,
        )
    return float(value)


def append_segment_words(
    output: list[WordTimestamp], segment: object, *, duration: float,
) -> None:
    words = getattr(segment, "words", None)
    if words is None:
        if str(getattr(segment, "text", "")).strip():
            raise ServiceError(
                "timing_unavailable", "recognizer did not return requested word timing",
                422, retryable=False,
            )
        return
    for word in words:
        text = getattr(word, "word", None)
        if not isinstance(text, str) or not text.strip() or len(text) > 256:
            raise ServiceError(
                "timing_unavailable", "recognizer returned invalid word metadata",
                422, retryable=False,
            )
        start = timing_number(getattr(word, "start", None), maximum=duration)
        end = timing_number(getattr(word, "end", None), maximum=duration)
        if end < start or (output and start < output[-1]["start"]):
            raise ServiceError(
                "timing_unavailable", "recognizer returned unordered word timing",
                422, retryable=False,
            )
        if len(output) >= MAX_WORDS:
            raise ServiceError(
                "output_too_large", "word metadata exceeds its limit", 413, retryable=False,
            )
        item: WordTimestamp = {"word": text, "start": start, "end": end}
        probability = getattr(word, "probability", None)
        if probability is not None:
            item["probability"] = timing_number(probability, maximum=1)
        output.append(item)
