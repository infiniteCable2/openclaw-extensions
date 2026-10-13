from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

import syntok.segmenter

from .speech_profile import CHATTERBOX_SPEECH_PROFILE, SpeechProfile

_CLAUSE_END = re.compile(r"[;:,–—]\s+", re.UNICODE)
_WORD = re.compile(r"\b\w+\b", re.UNICODE)

@dataclass(frozen=True, slots=True)
class SpeechSegment:
    text: str
    pause_after_ms: int


def _word_count(text: str) -> int:
    return len(_WORD.findall(text))


def _split_paragraphs(text: str) -> list[list[str]]:
    paragraphs: list[list[str]] = []
    for paragraph in syntok.segmenter.analyze(text):
        sentences = [
            "".join(map(str, sentence)).strip()
            for sentence in paragraph
        ]
        if sentences:
            paragraphs.append(sentences)
    return paragraphs


def _within_limits(
    text: str, *, max_words: int, max_characters: int,
    budget_text: Callable[[str], str] = str,
) -> bool:
    measured = budget_text(text)
    return len(measured) <= max_characters and _word_count(measured) <= max_words


def _bound_sentence(
    text: str, *, max_words: int, max_characters: int,
    budget_text: Callable[[str], str] = str,
) -> list[str]:
    remaining = text.strip()
    pieces: list[str] = []
    while remaining:
        if _within_limits(remaining, max_words=max_words, max_characters=max_characters, budget_text=budget_text):
            pieces.append(remaining)
            break

        split_limit = min(len(remaining), max_characters)
        words = list(_WORD.finditer(remaining))
        if len(words) > max_words:
            split_limit = min(split_limit, words[max_words - 1].end())
        if not _within_limits(remaining[:split_limit], max_words=max_words,
                              max_characters=max_characters, budget_text=budget_text):
            safe_limits = [match.start() for match in re.finditer(r"\s+", remaining[:split_limit])
                           if match.start() > 0 and _within_limits(
                               remaining[:match.start()], max_words=max_words,
                               max_characters=max_characters, budget_text=budget_text)]
            if not safe_limits:
                raise ValueError("atomic speech unit exceeds its profile limits")
            split_limit = safe_limits[-1]
        window = remaining[:split_limit]
        preferred_start = max(1, int(split_limit * 0.45))
        clause_breaks = [
            match.end() for match in _CLAUSE_END.finditer(window) if match.end() >= preferred_start
        ]
        whitespace_breaks = [
            match.start()
            for match in re.finditer(r"\s+", window)
            if match.start() >= preferred_start
        ]
        split_at = clause_breaks[-1] if clause_breaks else (
            whitespace_breaks[-1] if whitespace_breaks else split_limit
        )
        piece = remaining[:split_at].strip()
        if not piece:
            piece = remaining[:split_limit].strip()
            split_at = split_limit
        pieces.append(piece)
        remaining = remaining[split_at:].strip()
    return pieces


def _pause_after(text: str, *, paragraph_end: bool, profile: SpeechProfile) -> int:
    if paragraph_end:
        return profile.paragraph_pause
    stripped = text.rstrip()
    if stripped.endswith((".", "!", "?", "»", "”")):
        return profile.sentence_pause
    if stripped.endswith((";", ":", ",", "–", "—")):
        return profile.clause_pause
    return profile.fragment_pause


def split_speech_text(
    text: str,
    *,
    target_words: int | None = None,
    max_words: int | None = None,
    max_characters: int | None = None,
    profile: SpeechProfile = CHATTERBOX_SPEECH_PROFILE,
    budget_text: Callable[[str], str] = str,
) -> list[SpeechSegment]:
    """Split speech at linguistic boundaries while preserving all source words."""
    normalized = str(text or "").strip()
    if not normalized:
        return []
    target_words = profile.target_words if target_words is None else target_words
    max_words = profile.max_words if max_words is None else max_words
    max_characters = profile.max_chars if max_characters is None else max_characters
    if target_words < 1 or max_words < target_words or max_characters < 64:
        raise ValueError("speech segment limits are invalid")

    paragraphs = _split_paragraphs(normalized)
    segments: list[SpeechSegment] = []
    for paragraph_index, sentences in enumerate(paragraphs):
        units = [
            unit
            for sentence in sentences
            for unit in _bound_sentence(
                sentence,
                max_words=max_words,
                max_characters=max_characters,
                budget_text=budget_text,
            )
        ]
        current = ""
        for unit in units:
            candidate = f"{current} {unit}".strip() if current else unit
            if current and (
                _word_count(budget_text(candidate)) > target_words
                or not _within_limits(
                    candidate,
                    max_words=max_words,
                    max_characters=max_characters,
                    budget_text=budget_text,
                )
            ):
                segments.append(SpeechSegment(current, _pause_after(current, paragraph_end=False, profile=profile)))
                current = unit
            else:
                current = candidate
        if current:
            paragraph_end = paragraph_index < len(paragraphs) - 1
            segments.append(SpeechSegment(current, _pause_after(current, paragraph_end=paragraph_end, profile=profile)))
    # Standalone synthesis has the complete input. Merge short units across
    # paragraph boundaries, without stretching the model's hard safety limits.
    if profile.min_chars:
        index = 0
        while index < len(segments) - 1:
            left, right = segments[index:index + 2]
            combined = f"{left.text} {right.text}"
            if (min(len(budget_text(left.text)), len(budget_text(right.text))) < profile.min_chars
                    and _within_limits(combined, max_words=max_words, max_characters=max_characters, budget_text=budget_text)):
                segments[index:index + 2] = [SpeechSegment(combined, right.pause_after_ms)]
                index = max(0, index - 1)
            else:
                index += 1
    return segments


def validate_prepared_segments(text: str, value: object, profile: SpeechProfile) -> list[SpeechSegment]:
    """Consume the native owner's plan, never repair, reorder, or re-segment it."""
    if not isinstance(value, dict) or set(value) != {"schema_version", "segments"} or type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ValueError("prepared segmentation fields are invalid")
    raw = value["segments"]
    if not isinstance(raw, list) or not 1 <= len(raw) <= 128:
        raise ValueError("prepared segmentation must contain between one and 128 entries")
    result: list[SpeechSegment] = []
    cursor = 0
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"text", "pauseMs"}:
            raise ValueError("prepared speech segment fields are invalid")
        unit, pause = item["text"], item["pauseMs"]
        if not isinstance(unit, str) or not unit or unit != unit.strip():
            raise ValueError("prepared speech segment must be non-empty trimmed text")
        if not _within_limits(unit, max_words=profile.max_words, max_characters=profile.max_chars):
            raise ValueError("prepared speech segment exceeds backend limits")
        if type(pause) is not int or pause not in {
            0, profile.paragraph_pause, profile.sentence_pause, profile.clause_pause, profile.fragment_pause,
        }:
            raise ValueError("prepared speech pause does not match backend profile")
        while cursor < len(text) and text[cursor].isspace():
            cursor += 1
        if not text.startswith(unit, cursor):
            raise ValueError("prepared speech segments must preserve the exact ordered input")
        end = cursor + len(unit)
        if end < len(text) and all(char.isalnum() or char == "_" for char in text[end - 1:end + 1]):
            raise ValueError("prepared speech segment must not split a word")
        cursor = end
        result.append(SpeechSegment(unit, pause))
    if text[cursor:].strip():
        raise ValueError("prepared speech segments must cover the entire input")
    return result
