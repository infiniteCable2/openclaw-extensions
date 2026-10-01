from __future__ import annotations

import json
import logging
import math
from contextlib import closing
from pathlib import Path
from time import perf_counter
from typing import Generator, Protocol

from .recognition import RecognitionEvidence


TranscriptionEvents = Generator[dict[str, object], None, None]


def _duration_ms(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return round(min(value, (2**53 - 1) / 1000) * 1000)


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

    def transcribe_stream(
        self,
        audio_path: Path,
        *,
        language: str | None,
        prompt: str | None,
    ) -> TranscriptionEvents: ...


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
        with closing(self.transcribe_stream(audio_path, language=language, prompt=prompt)) as events:
            for event in events:
                if event["type"] == "transcript.done":
                    return str(event["text"])
        raise RuntimeError("Transcription ended without a result")

    def transcribe_stream(
        self,
        audio_path: Path,
        *,
        language: str | None,
        prompt: str | None,
    ) -> TranscriptionEvents:
        started = perf_counter()
        prepare_finished: float | None = None
        decode_started: float | None = None
        decode_finished: float | None = None
        info = None
        segments = None
        evidence = RecognitionEvidence()
        outcome = "failed"
        try:
            try:
                segments, info = self._model.transcribe(
                    str(audio_path),
                    language=language,
                    initial_prompt=prompt,
                    vad_filter=self.vad_filter,
                )
            finally:
                prepare_finished = perf_counter()
            retained = getattr(info, "duration_after_vad", None)
            if (
                self.vad_filter
                and isinstance(retained, (int, float))
                and not isinstance(retained, bool)
                and math.isfinite(retained)
                and retained > 0
            ):
                # Faster-Whisper has completed preparation/VAD, but the lazy
                # text decoder has not been advanced yet.
                yield {"type": "speech.confirmed"}
            decode_started = perf_counter()
            try:
                texts: list[str] = []
                for segment in segments:
                    evidence.add_segment()
                    evidence.add_signal(
                        "fasterWhisper.avgLogProbability",
                        getattr(segment, "avg_logprob", None), minimum=-100, maximum=0,
                    )
                    evidence.add_signal(
                        "fasterWhisper.noSpeechProbability",
                        getattr(segment, "no_speech_prob", None), minimum=0, maximum=1,
                    )
                    evidence.add_signal(
                        "fasterWhisper.compressionRatio",
                        getattr(segment, "compression_ratio", None), minimum=0, maximum=100,
                    )
                    if text := str(getattr(segment, "text", "")).strip():
                        texts.append(text)
                result = " ".join(texts).strip()
                outcome = "transcribed" if result else "empty"
            finally:
                decode_finished = perf_counter()
        except GeneratorExit:
            outcome = "cancelled"
            raise
        finally:
            if callable(close_segments := getattr(segments, "close", None)):
                close_segments()
            try:
                # Reuse the configured Flask service logger without importing app.
                # No media, text, paths, model IDs, or exception values enter it.
                logging.getLogger("openclaw_local_stt.app").info(json.dumps(
                    {
                        "event": "local_media_stt_backend",
                        "outcome": outcome,
                        "vadEnabled": self.vad_filter,
                        "durationMs": _duration_ms(getattr(info, "duration", None)),
                        "durationAfterVadMs": _duration_ms(
                            getattr(info, "duration_after_vad", None)
                        ),
                        "segmentCount": evidence.segment_count,
                        "prepareMs": (
                            _duration_ms(prepare_finished - started)
                            if prepare_finished is not None else None
                        ),
                        "decodeMs": (
                            _duration_ms(decode_finished - decode_started)
                            if decode_started is not None and decode_finished is not None
                            else None
                        ),
                        "totalMs": _duration_ms(perf_counter() - started),
                    },
                    allow_nan=False,
                    separators=(",", ":"),
                ))
            except Exception:
                # Diagnostics must neither fail successful inference nor mask
                # the original inference exception when a logger is unavailable.
                pass
        yield {
            "type": "transcript.done", "text": result, "model": self.model_id,
            "recognition": evidence.result(
                audio_duration_ms=_duration_ms(getattr(info, "duration", None)),
                speech_duration_ms=(
                    _duration_ms(getattr(info, "duration_after_vad", None))
                    if self.vad_filter else None
                ),
            ),
        }
