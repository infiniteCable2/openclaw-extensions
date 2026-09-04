from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import re


_VOICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_CATALOG_KEYS = frozenset({"schema_version", "default_voice", "voices"})
_VOICE_KEYS = frozenset(
    {"id", "name", "reference_path", "locale", "description", "generation"}
)
_GENERATION_RANGES = {
    "exaggeration": (0.0, 2.0),
    "temperature": (0.01, 5.0),
    "cfg_weight": (0.0, 2.0),
}


@dataclass(frozen=True)
class VoiceDefinition:
    id: str
    name: str
    reference_path: Path
    locale: str | None = None
    description: str | None = None
    generation: dict[str, float] | None = None

    def public_dict(self) -> dict[str, str]:
        value = {"id": self.id, "name": self.name}
        if self.locale:
            value["locale"] = self.locale
        if self.description:
            value["description"] = self.description
        return value


@dataclass(frozen=True)
class VoiceCatalog:
    default_voice: str
    voices: tuple[VoiceDefinition, ...]

    @property
    def references(self) -> dict[str, Path]:
        return {voice.id: voice.reference_path for voice in self.voices}

    @property
    def generation_settings(self) -> dict[str, dict[str, float]]:
        return {voice.id: dict(voice.generation or {}) for voice in self.voices}

    @property
    def public_voices(self) -> tuple[dict[str, str], ...]:
        return tuple(voice.public_dict() for voice in self.voices)


def _required_string(value: object, *, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum:
        raise ValueError(f"{field} exceeds its limit")
    return normalized


def _optional_string(value: object, *, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    return _required_string(value, field=field, maximum=maximum)


def _generation_settings(value: object) -> dict[str, float]:
    if value is None:
        return {}
    if not isinstance(value, dict) or set(value) - set(_GENERATION_RANGES):
        raise ValueError("voice generation settings are invalid")
    settings: dict[str, float] = {}
    for key, raw in value.items():
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError(f"voice generation setting {key} must be numeric")
        normalized = float(raw)
        minimum, maximum = _GENERATION_RANGES[key]
        if not math.isfinite(normalized) or not minimum <= normalized <= maximum:
            raise ValueError(f"voice generation setting {key} is outside its range")
        settings[key] = normalized
    return settings


def load_voice_catalog(path: Path) -> VoiceCatalog:
    if not path.is_absolute():
        raise ValueError("voice catalog path must be absolute")
    if path.is_symlink():
        raise ValueError("voice catalog must not be a symlink")
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.stat().st_size > 64 * 1024:
        raise ValueError("voice catalog is missing or exceeds its size limit")
    try:
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("voice catalog is unreadable") from exc
    if not isinstance(raw, dict) or set(raw) != _CATALOG_KEYS:
        raise ValueError("voice catalog fields are invalid")
    if raw.get("schema_version") != 1:
        raise ValueError("voice catalog schema version is unsupported")
    default_voice = _required_string(
        raw.get("default_voice"), field="default_voice", maximum=64
    )
    raw_voices = raw.get("voices")
    if not isinstance(raw_voices, list) or not 1 <= len(raw_voices) <= 64:
        raise ValueError("voice catalog must contain between one and 64 voices")

    voices: list[VoiceDefinition] = []
    ids: set[str] = set()
    for raw_voice in raw_voices:
        if not isinstance(raw_voice, dict) or set(raw_voice) - _VOICE_KEYS:
            raise ValueError("voice definition fields are invalid")
        voice_id = _required_string(raw_voice.get("id"), field="voice id", maximum=64)
        if not _VOICE_ID_PATTERN.fullmatch(voice_id) or voice_id in ids:
            raise ValueError("voice id is invalid or duplicated")
        reference_value = _required_string(
            raw_voice.get("reference_path"), field="reference_path", maximum=4096
        )
        reference = Path(reference_value)
        if not reference.is_absolute() or reference.is_symlink():
            raise ValueError("voice reference must be an absolute non-symlink file")
        resolved_reference = reference.resolve(strict=True)
        if not resolved_reference.is_file():
            raise ValueError("voice reference must be an absolute non-symlink file")
        voices.append(
            VoiceDefinition(
                id=voice_id,
                name=_required_string(raw_voice.get("name"), field="voice name", maximum=128),
                reference_path=resolved_reference,
                locale=_optional_string(raw_voice.get("locale"), field="locale", maximum=32),
                description=_optional_string(
                    raw_voice.get("description"), field="description", maximum=512
                ),
                generation=_generation_settings(raw_voice.get("generation")),
            )
        )
        ids.add(voice_id)
    if default_voice not in ids:
        raise ValueError("default_voice must name a configured voice")
    return VoiceCatalog(default_voice=default_voice, voices=tuple(voices))
