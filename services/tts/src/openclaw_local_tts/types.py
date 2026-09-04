from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RenderedPcm:
    data: bytes
    sample_rate: int


class SynthesisBackend(Protocol):
    model_id: str
    default_voice: str
    voice_ids: frozenset[str]
    public_voices: tuple[dict[str, str], ...]
    requested_backend: str
    observed_backend: str

    def synthesize(self, text: str, *, voice_id: str) -> RenderedPcm: ...


class AudioEncoder(Protocol):
    def encode(self, rendered: RenderedPcm, *, output_format: str, sample_rate: int | None) -> bytes: ...
