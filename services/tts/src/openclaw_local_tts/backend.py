from __future__ import annotations

import inspect
import os
import re
import sys
from pathlib import Path

from .types import RenderedPcm

_VOICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ChatterboxBackend:
    """One offline Chatterbox Multilingual v3 model on mandatory CUDA."""

    def __init__(
        self,
        *,
        model_path: Path,
        voice_references: dict[str, Path],
        default_voice: str,
        chatterbox_source: Path,
        perth_source: Path,
        s3tokenizer_source: Path,
        public_voices: tuple[dict[str, str], ...] | None = None,
        voice_generation_settings: dict[str, dict[str, float]] | None = None,
        model_id: str = "chatterbox",
        language: str = "de",
    ) -> None:
        paths = {
            "model_path": model_path,
            "chatterbox_source": chatterbox_source,
            "perth_source": perth_source,
            "s3tokenizer_source": s3tokenizer_source,
        }
        for name, value in paths.items():
            if not value.is_absolute():
                raise ValueError(f"{name} must be absolute")
        self._model_path = model_path.resolve(strict=True)
        if not voice_references:
            raise ValueError("at least one voice reference is required")
        self._voice_references: dict[str, Path] = {}
        for voice_id, reference_path in voice_references.items():
            if not _VOICE_ID_PATTERN.fullmatch(voice_id):
                raise ValueError("voice id is invalid")
            if not reference_path.is_absolute():
                raise ValueError("voice reference paths must be absolute")
            resolved_reference = reference_path.resolve(strict=True)
            if not resolved_reference.is_file():
                raise ValueError("voice reference paths must be files")
            self._voice_references[voice_id] = resolved_reference
        source_paths = [
            chatterbox_source.resolve(strict=True),
            perth_source.resolve(strict=True),
            s3tokenizer_source.resolve(strict=True),
        ]
        if not self._model_path.is_dir():
            raise ValueError("model_path must be a directory")
        if any(not path.is_dir() for path in source_paths):
            raise ValueError("all source paths must be directories")
        if not model_id.strip() or not language.strip():
            raise ValueError("model and language must be non-empty")
        if default_voice not in self._voice_references:
            raise ValueError("default_voice must name a configured voice reference")

        for source in [
            source_paths[0],
            source_paths[0] / "src",
            source_paths[1],
            source_paths[1] / "src",
            source_paths[2],
        ]:
            if source.is_dir() and str(source) not in sys.path:
                sys.path.insert(0, str(source))
        os.environ["TRANSFORMERS_ATTN_IMPLEMENTATION"] = "sdpa"

        import torch
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        from_local = getattr(ChatterboxMultilingualTTS, "from_local", None)
        if not callable(from_local):
            raise RuntimeError("Chatterbox from_local loader is unavailable")
        loader_parameters = inspect.signature(from_local).parameters
        if "device" not in loader_parameters or "t3_model" not in loader_parameters:
            raise RuntimeError("Chatterbox loader cannot enforce CUDA and multilingual v3")
        kwargs: dict[str, object] = {"device": "cuda", "t3_model": "v3"}
        self._client = from_local(str(self._model_path), **kwargs)
        observed = str(getattr(self._client, "device", "unknown")).strip().lower()
        if not observed.startswith("cuda"):
            raise RuntimeError("Chatterbox did not initialize on the requested CUDA backend")

        self.model_id = model_id.strip()
        self.default_voice = default_voice
        self.voice_ids = frozenset(self._voice_references)
        self.public_voices = public_voices or tuple(
            {"id": voice_id, "name": voice_id} for voice_id in self._voice_references
        )
        if {voice["id"] for voice in self.public_voices} != set(self.voice_ids):
            raise ValueError("public voice metadata must match configured voice references")
        self._voice_generation_settings = {
            voice_id: dict((voice_generation_settings or {}).get(voice_id, {}))
            for voice_id in self.voice_ids
        }
        self.language = language.strip()
        self.requested_backend = "cuda"
        self.observed_backend = "cuda"
        self.sample_rate = int(getattr(self._client, "sr", 24_000))
        if self.sample_rate <= 0:
            raise RuntimeError("Chatterbox returned an invalid sample rate")

    def synthesize(self, text: str, *, voice_id: str) -> RenderedPcm:
        import numpy as np
        import torch

        waveform = self._client.generate(
            text=text,
            language_id=self.language,
            audio_prompt_path=str(self._voice_references[voice_id]),
            **self._voice_generation_settings[voice_id],
        )
        if waveform is None:
            raise RuntimeError("Chatterbox returned no audio")
        if isinstance(waveform, torch.Tensor):
            array = waveform.detach().float().cpu().numpy()
        else:
            array = np.asarray(waveform, dtype=np.float32)
        array = np.squeeze(array)
        if array.ndim != 1 or array.size == 0:
            raise RuntimeError("Chatterbox returned invalid mono audio")
        pcm = np.rint(np.clip(array, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
        return RenderedPcm(data=pcm.tobytes(), sample_rate=self.sample_rate)
