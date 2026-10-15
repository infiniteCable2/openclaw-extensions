"""Speech-only expression plans; visible text is never rewritten by a backend."""
from __future__ import annotations

import re
from collections.abc import Mapping

import syntok.segmenter

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
# Plain input keeps its existing profile limits. Repeated presentation tags
# need a separate bounded envelope; they do not add spoken words or GPU units.
_MAX_RENDERED_UNIT = 8192


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
    boundaries: list[int] = []
    controls = int(emotion is not None)
    changes: list[tuple[int, str]] = [(0, emotion)] if emotion is not None else []
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
        elif "text" in part and not set(part) - {"text", "emphasis", "emotion"}:
            value = part["text"]
            if not isinstance(value, str) or not value:
                raise ValueError("expression text must be non-empty")
            validate_plain_expression_text(value)
            offset = sum(map(len, source))
            source.append(value)
            if "emotion" in part:
                part_emotion = part["emotion"]
                if not isinstance(part_emotion, str) or part_emotion not in capabilities.get("emotions", []):
                    raise ValueError("expression emotion is unsupported")
                changes.append((offset, part_emotion))
                boundaries.append(offset)
                controls += 1
            emphasis = part.get("emphasis", False)
            if not isinstance(emphasis, bool):
                raise ValueError("expression emphasis must be boolean")
            if not emphasis:
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
    if controls > 64:
        raise ValueError("expression controls exceed their limit")
    if "".join(source) != text:
        raise ValueError("expression text must exactly match the plain speech input")
    for offset in boundaries:
        if 0 < offset < len(text) and all(
            char.isalnum() or char == "_" for char in text[offset - 1:offset + 1]
        ):
            raise ValueError("expression controls must not split a word")
    operations = _sentence_emotions(text, operations, changes)
    if prepared_segments is not None:
        return _render_prepared(text, prepared_segments, operations, changes)
    protected: list[str] = []
    replacements: dict[str, str] = {}
    cursor = 0
    for index, (left, right, markup) in enumerate(operations):
        protected.append(text[cursor:left])
        token = f"{_SENTINEL}{index:03d}"
        # Count restored markup, not its placeholder, against model limits.
        token += "X" * max(0, len(markup) - len(token))
        replacements[token] = markup
        protected.append(f" {token} ")
        cursor = right
    protected.append(text[cursor:])
    def restored_budget(value: str) -> str:
        for token, markup in replacements.items():
            value = value.replace(token, markup)
        # Sentence annotations must not force extra standalone generation calls.
        # Events/emphasis retain their established atomic budget accounting.
        return re.sub(r"\[[a-z]+\]\s*", "", value)

    segments = split_speech_text(
        "".join(protected), max_characters=min(300, profile.max_chars), profile=profile,
        budget_text=restored_budget,
    )
    rendered: list[SpeechSegment] = []
    active = emotion
    for segment in segments:
        value = segment.text
        for token, markup in replacements.items():
            value = value.replace(token, markup)
        if _SENTINEL in value:
            raise ValueError("expression control was split")
        value = re.sub(r"[ \t]+", " ", value).strip()
        value = re.sub(r"\s+([.,;:!?])", r"\1", value)
        value = _prefix_emotion(value, active)
        labels = re.findall(r"\[([a-z]+)\]", value)
        if labels:
            active = labels[-1]
        if len(value) > _MAX_RENDERED_UNIT:
            raise ValueError("rendered expression unit exceeds its limit")
        rendered.append(SpeechSegment(value, segment.pause_after_ms))
    return rendered


def _emotion_at(changes: list[tuple[int, str]], offset: int) -> str | None:
    return next((label for position, label in reversed(changes) if position <= offset), None)


def _prefix_emotion(value: str, emotion: str | None) -> str:
    return f"[{emotion}] {value}" if emotion is not None and not re.match(r"\[[a-z]+\]", value) else value


def _sentence_emotions(
    text: str,
    operations: list[tuple[int, int, str]],
    changes: list[tuple[int, str]],
) -> list[tuple[int, int, str]]:
    """Render presentation at plain-text offsets, without choosing generation boundaries."""
    if not changes:
        return operations
    starts = {sentence[0].offset for paragraph in syntok.segmenter.analyze(text)
              for sentence in paragraph if sentence}
    # Parts may own leading whitespace. Render at their first spoken character,
    # not after the preceding sentence or twice before the same sentence.
    for offset, _ in changes:
        while offset < len(text) and text[offset].isspace():
            offset += 1
        if offset < len(text):
            starts.add(offset)
    tags = {offset: f"[{label}]" for offset in starts
            if (label := _emotion_at(changes, offset)) is not None}
    result: list[tuple[int, int, str]] = []
    for left, right, markup in operations:
        if right > left:
            # Preserve atomic emphasis even when it contains several sentences.
            interior = sorted(offset for offset in tags if left < offset < right)
            if interior:
                pieces: list[str] = []
                cursor = left
                for offset in interior:
                    pieces.extend((f"((({text[cursor:offset].rstrip()})))", tags.pop(offset)))
                    cursor = offset
                pieces.append(f"((({text[cursor:right]})))")
                markup = " ".join(pieces)
        result.append((left, right, markup))
    result.extend((offset, offset, tag) for offset, tag in tags.items())
    # Boundary events keep their existing ownership by the preceding unit;
    # emotion changes precede the next unit's text/emphasis, never those events.
    return sorted(result, key=lambda item: (
        item[0], 0 if item[2].startswith("<") else 1 if item[2].startswith("[") else 2,
    ))


def _render_prepared(
    text: str,
    segments: list[SpeechSegment],
    operations: list[tuple[int, int, str]],
    changes: list[tuple[int, str]],
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
            if left > end or (left == end and (right > left or markup.startswith("["))):
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
        value = _prefix_emotion(value, _emotion_at(changes, start))
        if len(value) > _MAX_RENDERED_UNIT:
            raise ValueError("rendered expression unit exceeds its limit")
        rendered.append(SpeechSegment(value, segment.pause_after_ms))
        previous_end = end
    # Events in trailing whitespace belong to the final unit, once.
    if pending:
        if any(left != right or text[previous_end:left].strip() for left, right, _ in pending):
            raise ValueError("prepared segmentation did not preserve expression controls")
        last = rendered[-1]
        value = last.text + " " + " ".join(markup for _, _, markup in pending)
        if len(value) > _MAX_RENDERED_UNIT:
            raise ValueError("rendered expression unit exceeds its limit")
        rendered[-1] = SpeechSegment(value, last.pause_after_ms)
    return rendered
