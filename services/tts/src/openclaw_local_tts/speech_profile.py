"""Immutable backend limits, advertised once per admitted worker generation."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SpeechProfile:
    min_chars: int = 0
    target_words: int = 32
    max_words: int = 45
    max_chars: int = 400
    paragraph_pause: int = 320
    sentence_pause: int = 180
    clause_pause: int = 80
    fragment_pause: int = 60

    def __post_init__(self) -> None:
        values = (self.min_chars, self.target_words, self.max_words, self.max_chars,
                  self.paragraph_pause, self.sentence_pause, self.clause_pause, self.fragment_pause)
        if any(type(value) is not int for value in values):
            raise ValueError("speech profile values must be integers")
        if not (64 <= self.max_chars <= 2000 and 0 <= self.min_chars <= self.max_chars
                and 1 <= self.target_words <= self.max_words <= 200
                and all(0 <= pause <= 2000 for pause in values[4:])):
            raise ValueError("speech profile limits are invalid")

    def public(self) -> dict[str, object]:
        return {
            "minChars": self.min_chars, "targetWords": self.target_words,
            "maxWords": self.max_words, "maxChars": self.max_chars,
            "pauses": {"paragraph": self.paragraph_pause, "sentence": self.sentence_pause,
                       "clause": self.clause_pause, "fragment": self.fragment_pause},
        }

    @classmethod
    def parse(cls, value: object) -> SpeechProfile:
        if not isinstance(value, dict) or set(value) != {
            "minChars", "targetWords", "maxWords", "maxChars", "pauses",
        }:
            raise ValueError("speech profile fields are invalid")
        pauses = value["pauses"]
        if not isinstance(pauses, dict) or set(pauses) != {"paragraph", "sentence", "clause", "fragment"}:
            raise ValueError("speech profile pause fields are invalid")
        return cls(value["minChars"], value["targetWords"], value["maxWords"], value["maxChars"],
                   pauses["paragraph"], pauses["sentence"], pauses["clause"], pauses["fragment"])


CHATTERBOX_SPEECH_PROFILE = SpeechProfile()
# Kitten's reviewed SDK merges prompts below 130 characters to avoid held tokens.
# This is a packing preference, not a prohibition on short completed utterances.
KITTEN_SPEECH_PROFILE = SpeechProfile(
    min_chars=130, paragraph_pause=160, sentence_pause=120, clause_pause=60, fragment_pause=40,
)


def load_speech_profile(path: Path) -> SpeechProfile:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("speech profile must be an absolute regular non-symlink file")
    if path.stat().st_size > 16 * 1024:
        raise ValueError("speech profile file exceeds its limit")
    return SpeechProfile.parse(json.loads(path.read_text(encoding="utf-8")))
