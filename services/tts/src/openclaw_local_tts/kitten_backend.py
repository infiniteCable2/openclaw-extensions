from __future__ import annotations

import json
import os
from collections.abc import Iterable, Iterator
from pathlib import Path

from .expression import KITTEN_EXPRESSION_CAPABILITIES, validate_plain_expression_text
from .types import RenderedPcm
from .speech_profile import KITTEN_SPEECH_PROFILE
from .voice_catalog import VoiceCatalog


class KittenTts2Backend:
    """Optional offline CUDA backend. One loaded model, catalog-owned clone references."""

    expression_capabilities = KITTEN_EXPRESSION_CAPABILITIES
    speech_profile = KITTEN_SPEECH_PROFILE

    def __init__(
        self, *, model_path: Path, cache_dir: Path, catalog: VoiceCatalog,
        model_id: str = "kitten-tts-2", weights: str = "packed",
    ) -> None:
        if not model_path.is_absolute() or model_path.is_symlink():
            raise ValueError("model_path must be an absolute non-symlink directory")
        self._model_path = model_path.resolve(strict=True)
        if not cache_dir.is_absolute() or cache_dir.is_symlink() or not cache_dir.is_dir():
            raise ValueError("cache_dir must be an existing absolute non-symlink directory")
        cache_dir = cache_dir.resolve(strict=True)
        if not self._model_path.is_dir() or weights not in {"packed", "emb4"}:
            raise ValueError("model directory or weight selection is invalid")
        if not model_id.strip():
            raise ValueError("model id must be non-empty")
        config_path = self._model_path / "config.json"
        if config_path.is_symlink() or config_path.stat().st_size > 64 * 1024:
            raise ValueError("model configuration is invalid")
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(config, dict) or config.get("type") != "KITTEN2":
            raise ValueError("model configuration must select KittenTTS 2")
        for voice in catalog.voices:
            if not voice.reference_text:
                raise ValueError("each clone reference needs an explicit reference_text")
            if voice.generation:
                raise ValueError("Chatterbox generation settings cannot be applied to KittenTTS 2")

        # Separate worker processes own separate runtimes. Never download model/code
        # dependencies or implicitly load Whisper inside an inference request.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        import numpy as np
        import torch
        from kittenml import KittenTTS

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable")
        # The default codec has separately provisioned Chatterbox Turbo weights.
        # Never resolve these against an incidental shared/user cache or download.
        client = KittenTTS(
            str(self._model_path), cache_dir=str(cache_dir), device="cuda",
            backend="torch", decoder="default", weights=weights,
        )
        if str(client.device).split(":", 1)[0] != "cuda" or client.backend != "torch":
            raise RuntimeError("KittenTTS 2 did not initialize on the requested CUDA backend")
        self._verify_cuda_module(client.model, "language model")
        if client.sample_rate != 24_000:
            raise RuntimeError("KittenTTS 2 returned an unsupported sample rate")
        # Loading alone is not readiness: codec, embedding and clone conditioning are
        # lazy in upstream. Warm EVERY catalog voice before the listener is opened.
        for voice in catalog.voices:
            waveform = client.generate(
                "Bereit.", reference=str(voice.reference_path),
                reference_text=voice.reference_text, normalize=False, preset="stable",
                max_new_tokens=200, advanced={"use_emotion": False},
            )
            self._pcm(waveform, np)
        # These names are verified against the reviewed SDK; pin that SDK before
        # deployment. Missing/lazy/CPU components are not readiness success.
        self._verify_cuda_module(client.codec.s3gen, "codec")
        self._verify_cuda_module(client.speaker_encoder._model, "speaker encoder")
        if client.codec.student is not None or client.transcriber._pipeline is not None:
            raise RuntimeError("KittenTTS 2 unexpectedly loaded an alternative decoder or transcriber")
        self._client = client
        self._voices = {voice.id: voice for voice in catalog.voices}
        self.model_id = model_id.strip()
        self.default_voice = catalog.default_voice
        self.voice_ids = frozenset(self._voices)
        self.public_voices = catalog.public_voices
        self.requested_backend = self.observed_backend = "cuda"
        self.sample_rate = 24_000

    @staticmethod
    def _verify_cuda_module(module, name: str) -> None:
        if module is None:
            raise RuntimeError(f"KittenTTS 2 {name} was not loaded")
        devices = [str(parameter.device) for parameter in module.parameters()]
        buffers = [str(buffer.device) for buffer in module.buffers()]
        if not devices or not all(device.split(":", 1)[0] == "cuda" for device in devices + buffers):
            raise RuntimeError(f"KittenTTS 2 {name} contains non-CUDA tensors")

    @staticmethod
    def _pcm(waveform, np) -> RenderedPcm:
        array = np.asarray(waveform, dtype=np.float32)
        if array.ndim != 1 or not 0 < array.size <= 24_000 * 45 or not np.isfinite(array).all():
            raise RuntimeError("KittenTTS 2 returned invalid or oversized mono audio")
        pcm = np.rint(np.clip(array, -1.0, 1.0) * 32767.0).astype("<i2", copy=False)
        return RenderedPcm(data=pcm.tobytes(), sample_rate=24_000)

    def synthesize_segments(self, texts: Iterable[str], *, voice_id: str) -> Iterator[RenderedPcm]:
        yield from self._render(texts, voice_id=voice_id, expressive=False)

    def synthesize_expressive_segments(
        self, texts: Iterable[str], *, voice_id: str,
    ) -> Iterator[RenderedPcm]:
        yield from self._render(texts, voice_id=voice_id, expressive=True)

    def _render(
        self, texts: Iterable[str], *, voice_id: str, expressive: bool,
    ) -> Iterator[RenderedPcm]:
        import numpy as np

        voice = self._voices[voice_id]
        for text in texts:
            if not expressive:
                validate_plain_expression_text(text)
            # The service owns bounded units and their joins. Do not split/merge a
            # short unit again or silently move inline controls across its boundary.
            waveform = self._client.generate(
                text, reference=str(voice.reference_path), reference_text=voice.reference_text,
                normalize=False, preset="expressive" if expressive else "stable", max_new_tokens=1000,
                advanced={"use_emotion": expressive, "chunk_chars": 0, "chunk_min_chars": 0},
            )
            # Preserve all model-generated samples, including edge silence and
            # quiet expression cues. Joining pauses are owned by the service.
            yield self._pcm(waveform, np)
