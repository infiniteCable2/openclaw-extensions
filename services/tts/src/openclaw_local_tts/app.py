from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from typing import Iterator

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from .audio import join_speech_segments
from .speech_segments import split_speech_text
from .types import AudioEncoder, SynthesisBackend

_ALLOWED_FORMATS = {"opus", "pcm", "wav"}
_ALLOWED_SAMPLE_RATES = {8_000, 16_000, 24_000, 48_000}
_REQUEST_FIELDS = {"input", "model", "voice", "response_format", "sample_rate"}


class ServiceError(RuntimeError):
    def __init__(self, code: str, message: str, status: int, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


class ServiceState:
    def __init__(self, *, capacity: int) -> None:
        self.admission = threading.BoundedSemaphore(capacity)
        self.inference = threading.Lock()
        self.counters_lock = threading.Lock()
        self.active_requests = 0
        self.queue_depth = 0

    @contextmanager
    def admit(self) -> Iterator[None]:
        if not self.admission.acquire(blocking=False):
            raise ServiceError("overloaded", "TTS request queue is full", 429, retryable=True)
        with self.counters_lock:
            self.queue_depth += 1
        try:
            with self.inference:
                with self.counters_lock:
                    self.queue_depth -= 1
                    self.active_requests += 1
                try:
                    yield
                finally:
                    with self.counters_lock:
                        self.active_requests -= 1
        finally:
            self.admission.release()

    def snapshot(self) -> tuple[int, int]:
        with self.counters_lock:
            return self.active_requests, self.queue_depth


def _error_response(error: ServiceError) -> tuple[Response, int]:
    return (
        jsonify(
            error={
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
            }
        ),
        error.status,
    )


def _required_string(body: dict[str, object], name: str, max_length: int) -> str:
    value = body.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ServiceError("invalid_request", f"{name} is required", 400, retryable=False)
    normalized = value.strip()
    if len(normalized) > max_length:
        raise ServiceError("invalid_request", f"{name} exceeds its limit", 400, retryable=False)
    return normalized


def create_app(
    backend: SynthesisBackend,
    encoder: AudioEncoder,
    *,
    max_text_characters: int = 4096,
    max_queued_requests: int = 2,
) -> Flask:
    if max_text_characters < 10 or max_text_characters > 65_536:
        raise ValueError("max_text_characters is outside its allowed range")
    if max_queued_requests < 0 or max_queued_requests > 64:
        raise ValueError("max_queued_requests is outside its allowed range")

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    app.logger.setLevel(logging.INFO)
    state = ServiceState(capacity=1 + max_queued_requests)

    def readiness() -> dict[str, object]:
        active, queued = state.snapshot()
        return {
            "ready": True,
            "state": "busy" if active else "ready",
            "model": backend.model_id,
            "requestedBackend": backend.requested_backend,
            "observedBackend": backend.observed_backend,
            "activeRequests": active,
            "queueDepth": queued,
        }

    @app.errorhandler(RequestEntityTooLarge)
    def handle_request_too_large(_error: RequestEntityTooLarge) -> tuple[Response, int]:
        return _error_response(
            ServiceError(
                "payload_too_large",
                "request exceeds the configured size limit",
                413,
                retryable=False,
            )
        )

    @app.get("/live")
    def live() -> Response:
        return jsonify(live=True)

    @app.get("/ready")
    def ready() -> Response:
        return jsonify(readiness())

    @app.get("/status")
    def status() -> Response:
        return jsonify(readiness())

    @app.get("/v1/voices")
    def voices() -> Response:
        return jsonify(
            object="list",
            model=backend.model_id,
            default_voice=backend.default_voice,
            data=list(backend.public_voices),
        )

    @app.post("/v1/audio/speech")
    def synthesize() -> tuple[Response, int] | Response:
        try:
            if not request.is_json:
                raise ServiceError("invalid_request", "JSON body is required", 400, retryable=False)
            body = request.get_json(silent=False)
            if not isinstance(body, dict) or set(body) - _REQUEST_FIELDS:
                raise ServiceError("invalid_request", "request fields are invalid", 400, retryable=False)
            text = _required_string(body, "input", max_text_characters)
            model = _required_string(body, "model", 128)
            voice = _required_string(body, "voice", 64)
            output_format = _required_string(body, "response_format", 16).lower()
            if model != backend.model_id:
                raise ServiceError("model_unavailable", "requested model is unavailable", 400, retryable=False)
            if voice not in backend.voice_ids:
                raise ServiceError("invalid_request", "requested voice is unavailable", 400, retryable=False)
            if output_format not in _ALLOWED_FORMATS:
                raise ServiceError("invalid_request", "response format is unsupported", 400, retryable=False)
            sample_rate_value = body.get("sample_rate")
            if sample_rate_value is None:
                sample_rate = None
            elif isinstance(sample_rate_value, int) and sample_rate_value in _ALLOWED_SAMPLE_RATES:
                sample_rate = sample_rate_value
            else:
                raise ServiceError("invalid_request", "sample rate is unsupported", 400, retryable=False)

            with state.admit():
                segments = split_speech_text(text)
                rendered_segments = list(
                    backend.synthesize_segments(
                        (segment.text for segment in segments),
                        voice_id=voice,
                    )
                )
                rendered = join_speech_segments(
                    rendered_segments,
                    [segment.pause_after_ms for segment in segments],
                )
                audio = encoder.encode(
                    rendered,
                    output_format=output_format,
                    sample_rate=sample_rate,
                )
            content_types = {
                "opus": "audio/ogg",
                "pcm": "application/octet-stream",
                "wav": "audio/wav",
            }
            return Response(audio, status=200, content_type=content_types[output_format])
        except ServiceError as error:
            return _error_response(error)
        except BadRequest:
            return _error_response(
                ServiceError("invalid_request", "JSON body is invalid", 400, retryable=False)
            )
        except Exception as error:
            app.logger.error("TTS inference failed error_type=%s", type(error).__name__)
            return _error_response(
                ServiceError(
                    "inference_failed",
                    "TTS inference failed",
                    500,
                    retryable=True,
                )
            )

    return app
