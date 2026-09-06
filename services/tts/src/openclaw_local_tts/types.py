from __future__ import annotations

from collections.abc import Iterable, Iterator
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
    sample_rate: int

    def synthesize_segments(
        self,
        texts: Iterable[str],
        *,
        voice_id: str,
    ) -> Iterator[RenderedPcm]: ...


class AudioEncoder(Protocol):
    def encode(self, rendered: RenderedPcm, *, output_format: str, sample_rate: int | None) -> bytes: ...
