"""Kitten-only model text cleanup; never alter visible text or expression offsets."""
from __future__ import annotations

import regex

from .expression import KITTEN_EMOTIONS

_GRAPHEME = regex.compile(r"\X")
_EMOJI = regex.compile(
    r"\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|"
    r"\p{Emoji_Modifier}|\u20e3"
)
_ORPHAN_CONTROLS = regex.compile(r"\A[\u200d\ufe0e\ufe0f\U000e0020-\U000e007f]+\Z")
_EMOTION = regex.compile(r"\[(?:" + "|".join(KITTEN_EMOTIONS) + r")\]")
_CONTENT = regex.compile(r"[\p{L}\p{N}\p{S}]")


def prepare_kitten_text(text: str) -> str:
    def replace(match: regex.Match) -> str:
        cluster = match.group()
        # These are ordinary textual symbols unless explicitly emoji-presented.
        if cluster in {"©", "®", "™"}:
            return cluster
        if _EMOJI.search(cluster) or _ORPHAN_CONTROLS.fullmatch(cluster):
            # A separator prevents word concatenation and creation of new tags.
            return " "
        return cluster

    cleaned = _GRAPHEME.sub(replace, text)
    if cleaned == text:
        return text
    cleaned = regex.sub(r"[ \t]+", " ", cleaned).strip()
    # Emotion labels alone are not speech. Vocal-event tags remain renderable.
    return cleaned if _CONTENT.search(_EMOTION.sub("", cleaned)) else ""
