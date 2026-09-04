from __future__ import annotations

from pathlib import Path
from typing import Protocol


class TranscriptionBackend(Protocol):
    model_id: str
    requested_backend: str
    observed_backend: str

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None,
        prompt: str | None,
    ) -> str: ...


class FasterWhisperBackend:
    """One offline Faster-Whisper model with a mandatory CUDA backend."""

    def __init__(
        self,
        *,
        model_path: Path,
        model_id: str = "faster-whisper",
        compute_type: str = "float16",
        vad_filter: bool = True,
    ) -> None:
        if not model_path.is_absolute():
            raise ValueError("model_path must be an existing absolute directory")
        resolved_model_path = model_path.expanduser().resolve(strict=True)
        if not resolved_model_path.is_dir():
            raise ValueError("model_path must be an existing absolute directory")
        if not model_id.strip() or len(model_id) > 128:
            raise ValueError("model_id is invalid")

        from faster_whisper import WhisperModel

        self.model_id = model_id.strip()
        self.requested_backend = "cuda"
        self.compute_type = compute_type
        self.vad_filter = vad_filter
        self._model = WhisperModel(
            str(resolved_model_path),
            device="cuda",
            compute_type=compute_type,
            local_files_only=True,
        )
        observed = str(getattr(getattr(self._model, "model", None), "device", "unknown"))
        self.observed_backend = observed.strip().lower()
        if self.observed_backend != "cuda":
            raise RuntimeError("Faster-Whisper did not initialize on the requested CUDA backend")

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None,
        prompt: str | None,
    ) -> str:
        segments, _info = self._model.transcribe(
            str(audio_path),
            language=language,
            initial_prompt=prompt,
            vad_filter=self.vad_filter,
        )
        return " ".join(
            text
            for segment in segments
            if (text := str(getattr(segment, "text", "")).strip())
        ).strip()
