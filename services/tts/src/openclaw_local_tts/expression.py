"""Speech-only expression plans; visible text is never rewritten by a backend."""
from __future__ import annotations

import re
from collections.abc import Mapping

from .speech_segments import SpeechSegment, split_speech_text
from .speech_profile import CHATTERBOX_SPEECH_PROFILE, SpeechProfile

# The reviewed KittenTTS 2 recognition list, not its unbounded training vocabulary.
KITTEN_EMOTIONS = (
    "angry", "contemplative", "excited", "joyful", "mundane", "nervous",
    "sad", "stern", "surprised", "tender",
)
KITTEN_EVENTS = (
    "gasp", "giggle", "growl", "gulp", "laugh", "pause", "scoff", "sigh", "sob", "um",
)
KITTEN_EXPRESSION_CAPABILITIES = {
    "emotions": list(KITTEN_EMOTIONS),
    "vocalEvents": list(KITTEN_EVENTS),
    "emphasis": True,
    "whisper": False,
}
_RAW_CONTROL = re.compile(r"\[[A-Za-z]+\]|<[A-Za-z]+>|\(\(\(|\)\)\)|\[\[", re.ASCII)
_SENTINEL = "OCEXPRESSIONTOKEN"


def validate_plain_expression_text(text: str) -> None:
    # Do not guess whether raw markup is a quoted example or an executable direction.
    # Native OpenClaw directives must already have been resolved by their owner.
    if _RAW_CONTROL.search(text) or _SENTINEL in text:
        raise ValueError("speech input must use a structured expression plan, not raw controls")


def prepare_expression_segments(
    text: str,
    plan: object,
    capabilities: Mapping[str, object],
    *,
    profile: SpeechProfile = CHATTERBOX_SPEECH_PROFILE,
    prepared_segments: list[SpeechSegment] | None = None,
) -> list[SpeechSegment]:
    """Validate an opt-in plan, preserve its plain projection and protect atomic controls."""
    # Part boundaries must not turn admitted plain text into backend markup when joined.
    validate_plain_expression_text(text)
    if not isinstance(plan, dict) or set(plan) - {"emotion", "parts"}:
        raise ValueError("expression plan fields are invalid")
    emotion = plan.get("emotion")
    if emotion is not None and (
        not isinstance(emotion, str) or emotion not in capabilities.get("emotions", [])
    ):
        raise ValueError("expression emotion is unsupported")
    parts = plan.get("parts")
    if not isinstance(parts, list) or not 1 <= len(parts) <= 128:
        raise ValueError("expression parts must contain between one and 128 entries")
    source: list[str] = []
    protected: list[str] = []
    replacements: dict[str, str] = {}
    boundaries: list[int] = []
    controls = 0
    operations: list[tuple[int, int, str]] = []
    for part in parts:
        if not isinstance(part, dict):
            raise ValueError("expression part is invalid")
        if set(part) == {"event"}:
            event = part["event"]
            if not isinstance(event, str) or event not in capabilities.get("vocalEvents", []):
                raise ValueError("expression vocal event is unsupported")
            markup = f"<{event}>"
            offset = sum(map(len, source))
            boundaries.append(offset)
            operations.append((offset, offset, markup))
        elif set(part) in ({"text"}, {"text", "emphasis"}):
            value = part["text"]
            if not isinstance(value, str) or not value:
                raise ValueError("expression text must be non-empty")
            validate_plain_expression_text(value)
            offset = sum(map(len, source))
            source.append(value)
            emphasis = part.get("emphasis", False)
            if not isinstance(emphasis, bool):
                raise ValueError("expression emphasis must be boolean")
            if not emphasis:
                protected.append(value)
                continue
            if capabilities.get("emphasis") is not True or not 1 <= len(value) <= 80 or any(
                char in value for char in "()\r\n"
            ):
                raise ValueError("expression emphasis is unsupported or exceeds its limit")
            markup = f"((({value})))"
            boundaries.extend((offset, offset + len(value)))
            operations.append((offset, offset + len(value), markup))
        else:
            raise ValueError("expression part fields are invalid")
        controls += 1
        if controls > 64:
            raise ValueError("expression controls exceed their limit")
        token = f"{_SENTINEL}{controls:03d}"
        # A protected phrase must not look shorter than its restored markup to
        # the standalone splitter, nor become an attractive short-chunk merge.
        token += "X" * max(0, len(markup) - len(token))
        replacements[token] = markup
        protected.append(f" {token} ")
    if "".join(source) != text:
        raise ValueError("expression text must exactly match the plain speech input")
    for offset in boundaries:
        if 0 < offset < len(text) and all(
            char.isalnum() or char == "_" for char in text[offset - 1:offset + 1]
        ):
            raise ValueError("expression controls must not split a word")
    if prepared_segments is not None:
        return _render_prepared(text, prepared_segments, operations, emotion)
    def restored_budget(value: str) -> str:
        for token, markup in replacements.items():
            value = value.replace(token, markup)
        return f"[{emotion}] {value}" if emotion is not None and value.strip() else value

    segments = split_speech_text(
        "".join(protected), max_characters=min(300, profile.max_chars), profile=profile,
        budget_text=restored_budget,
    )
    rendered: list[SpeechSegment] = []
    for segment in segments:
        value = segment.text
        for token, markup in replacements.items():
            value = value.replace(token, markup)
        if _SENTINEL in value:
            raise ValueError("expression control was split")
        value = re.sub(r"[ \t]+", " ", value).strip()
        value = re.sub(r"\s+([.,;:!?])", r"\1", value)
        if emotion is not None:
            value = f"[{emotion}] {value}"
        if len(value) > 512:
            raise ValueError("rendered expression unit exceeds its limit")
        rendered.append(SpeechSegment(value, segment.pause_after_ms))
    return rendered


def _render_prepared(
    text: str,
    segments: list[SpeechSegment],
    operations: list[tuple[int, int, str]],
    emotion: str | None,
) -> list[SpeechSegment]:
    """Project controls onto validated native boundaries; no second chunker."""
    rendered: list[SpeechSegment] = []
    previous_end = 0
    pending = list(operations)
    for segment in segments:
        start = previous_end
        while start < len(text) and text[start].isspace():
            start += 1
        end = start + len(segment.text)
        chunks: list[str] = []
        cursor = start
        consumed = 0
        for left, right, markup in pending:
            if left > end or (left == end and right > left):
                break
            if right > left and (left < start or right > end):
                raise ValueError("prepared segmentation must not split an emphasis span")
            position = max(start, left)
            chunks.append(text[cursor:position])
            chunks.append(f" {markup} " if left == right else markup)
            cursor = max(position, right)
            consumed += 1
        del pending[:consumed]
        chunks.append(text[cursor:end])
        value = re.sub(r"[ \t]+", " ", "".join(chunks)).strip()
        value = re.sub(r"\s+([.,;:!?])", r"\1", value)
        if emotion is not None:
            value = f"[{emotion}] {value}"
        if len(value) > 512:
            raise ValueError("rendered expression unit exceeds its limit")
        rendered.append(SpeechSegment(value, segment.pause_after_ms))
        previous_end = end
    # Events in trailing whitespace belong to the final unit, once.
    if pending:
        if any(left != right or text[previous_end:left].strip() for left, right, _ in pending):
            raise ValueError("prepared segmentation did not preserve expression controls")
        last = rendered[-1]
        value = last.text + " " + " ".join(markup for _, _, markup in pending)
        if len(value) > 512:
            raise ValueError("rendered expression unit exceeds its limit")
        rendered[-1] = SpeechSegment(value, last.pause_after_ms)
    return rendered
