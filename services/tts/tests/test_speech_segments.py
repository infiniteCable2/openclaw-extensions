from __future__ import annotations

import re

from openclaw_local_tts.speech_segments import split_speech_text


def _words(text: str) -> list[str]:
    return re.findall(r"\b\w+\b", text, flags=re.UNICODE)


def test_speech_segments_preserve_content_and_prefer_sentence_boundaries() -> None:
    text = (
        "Der erste Satz bleibt vollständig erhalten. Der zweite Satz gehört dazu.\n\n"
        "Ein neuer Absatz beginnt hier und endet ruhig."
    )

    segments = split_speech_text(text, target_words=7, max_words=20, max_characters=200)

    assert [segment.text for segment in segments] == [
        "Der erste Satz bleibt vollständig erhalten.",
        "Der zweite Satz gehört dazu.",
        "Ein neuer Absatz beginnt hier und endet ruhig.",
    ]
    assert segments[1].pause_after_ms > segments[0].pause_after_ms
    assert [word for segment in segments for word in _words(segment.text)] == _words(text)


def test_speech_segments_bound_unpunctuated_text_without_losing_words() -> None:
    text = " ".join(f"wort{index}" for index in range(75))

    segments = split_speech_text(
        text,
        target_words=20,
        max_words=24,
        max_characters=180,
    )

    assert len(segments) > 1
    assert all(len(segment.text) <= 180 for segment in segments)
    assert all(len(_words(segment.text)) <= 24 for segment in segments)
    assert [word for segment in segments for word in _words(segment.text)] == _words(text)
