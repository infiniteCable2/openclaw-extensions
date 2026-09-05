from __future__ import annotations

import re
from dataclasses import dataclass


_SENTENCE_END = re.compile(r'[.!?]+(?:["»“”’\)\]]+)?(?=\s|$)')
_PARAGRAPH_BREAK = re.compile(r"\n\s*\n+", re.UNICODE)
_CLAUSE_END = re.compile(r"[;:,–—]\s+", re.UNICODE)
_WORD = re.compile(r"\b\w+\b", re.UNICODE)

# Chatterbox Multilingual v3 currently caps one generation at 1000 audio
# tokens (about 40 seconds at 25 tokens/s). These conservative limits keep a
# segment comfortably below that ceiling even for slower German speech.
DEFAULT_TARGET_WORDS = 32
DEFAULT_MAX_WORDS = 45
DEFAULT_MAX_CHARACTERS = 400


@dataclass(frozen=True, slots=True)
class SpeechSegment:
    text: str
    pause_after_ms: int


def _word_count(text: str) -> int:
    return len(_WORD.findall(text))


def _split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    last_end = 0
    for match in _SENTENCE_END.finditer(text):
        end = match.end()
        sentence = text[last_end:end]
        if sentence.strip():
            sentences.append(sentence.strip())
        last_end = end
    remainder = text[last_end:].strip()
    if remainder:
        sentences.append(remainder)
    return sentences


def _within_limits(text: str, *, max_words: int, max_characters: int) -> bool:
    return len(text) <= max_characters and _word_count(text) <= max_words


def _bound_sentence(text: str, *, max_words: int, max_characters: int) -> list[str]:
    remaining = text.strip()
    pieces: list[str] = []
    while remaining:
        if _within_limits(remaining, max_words=max_words, max_characters=max_characters):
            pieces.append(remaining)
            break

        split_limit = min(len(remaining), max_characters)
        words = list(_WORD.finditer(remaining))
        if len(words) > max_words:
            split_limit = min(split_limit, words[max_words - 1].end())
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


def _pause_after(text: str, *, paragraph_end: bool) -> int:
    if paragraph_end:
        return 320
    stripped = text.rstrip()
    if stripped.endswith((".", "!", "?", "»", "”")):
        return 180
    if stripped.endswith((";", ":", ",", "–", "—")):
        return 80
    return 60


def split_speech_text(
    text: str,
    *,
    target_words: int = DEFAULT_TARGET_WORDS,
    max_words: int = DEFAULT_MAX_WORDS,
    max_characters: int = DEFAULT_MAX_CHARACTERS,
) -> list[SpeechSegment]:
    """Split speech at linguistic boundaries while preserving all source words."""
    normalized = str(text or "").strip()
    if not normalized:
        return []
    if target_words < 1 or max_words < target_words or max_characters < 64:
        raise ValueError("speech segment limits are invalid")

    paragraphs = [part.strip() for part in _PARAGRAPH_BREAK.split(normalized) if part.strip()]
    segments: list[SpeechSegment] = []
    for paragraph_index, paragraph in enumerate(paragraphs):
        units = [
            unit
            for sentence in _split_sentences(paragraph)
            for unit in _bound_sentence(
                sentence,
                max_words=max_words,
                max_characters=max_characters,
            )
        ]
        current = ""
        for unit in units:
            candidate = f"{current} {unit}".strip() if current else unit
            if current and (
                _word_count(candidate) > target_words
                or not _within_limits(
                    candidate,
                    max_words=max_words,
                    max_characters=max_characters,
                )
            ):
                segments.append(SpeechSegment(current, _pause_after(current, paragraph_end=False)))
                current = unit
            else:
                current = candidate
        if current:
            paragraph_end = paragraph_index < len(paragraphs) - 1
            segments.append(SpeechSegment(current, _pause_after(current, paragraph_end=paragraph_end)))
    return segments
