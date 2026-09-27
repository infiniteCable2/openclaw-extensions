from __future__ import annotations

import json
import logging
import tempfile
import threading
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Callable, Iterator

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from .backend import TranscriptionBackend
from .speech_frontend import enhance_speech_file

_ALLOWED_AUDIO_TYPES = {
    "application/octet-stream",
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
}

_AUDIO_SUFFIXES = {
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/m4a": ".m4a",
    "audio/mp4": ".mp4",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
    "audio/x-m4a": ".m4a",
    "audio/x-wav": ".wav",
}

_ALLOWED_FILENAME_SUFFIXES = frozenset(_AUDIO_SUFFIXES.values())


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
            raise ServiceError("overloaded", "STT request queue is full", 429, retryable=True)
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


def _validate_optional_text(name: str, value: str | None, max_length: int) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if len(normalized) > max_length:
        raise ServiceError("invalid_request", f"{name} exceeds its limit", 400, retryable=False)
    return normalized


def _sse_event(event: dict[str, object]) -> bytes:
    return ("data: " + json.dumps(event, separators=(",", ":")) + "\n\n").encode("utf-8")


def _store_bounded_upload(*, max_audio_bytes: int) -> Path:
    upload = request.files.get("file")
    if upload is None:
        raise ServiceError("invalid_request", "file is required", 400, retryable=False)
    content_type = (upload.mimetype or "application/octet-stream").lower()
    if content_type not in _ALLOWED_AUDIO_TYPES:
        raise ServiceError("unsupported_media", "audio media type is unsupported", 400, retryable=False)

    suffix = _AUDIO_SUFFIXES.get(content_type)
    if suffix is None:
        candidate = Path(upload.filename or "").suffix.lower()
        suffix = candidate if candidate in _ALLOWED_FILENAME_SUFFIXES else ".audio"

    temp = tempfile.NamedTemporaryFile(prefix="openclaw-stt-", suffix=suffix, delete=False)
    path = Path(temp.name)
    total = 0
    try:
        with temp:
            while chunk := upload.stream.read(64 * 1024):
                total += len(chunk)
                if total > max_audio_bytes:
                    raise ServiceError(
                        "payload_too_large",
                        "audio exceeds the configured size limit",
                        413,
                        retryable=False,
                    )
                temp.write(chunk)
        if total == 0:
            raise ServiceError("invalid_request", "audio is empty", 400, retryable=False)
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


def create_app(
    backend: TranscriptionBackend,
    *,
    max_audio_bytes: int = 20 * 1024 * 1024,
    max_queued_requests: int = 2,
    speech_frontend: Callable[[Path], Path] = enhance_speech_file,
) -> Flask:
    if max_audio_bytes < 1024:
        raise ValueError("max_audio_bytes must be at least 1024")
    if max_queued_requests < 0 or max_queued_requests > 64:
        raise ValueError("max_queued_requests is outside its allowed range")

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = max_audio_bytes + 1024 * 1024
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

    def streaming_response(
        audio_path: Path, *, language: str | None, prompt: str | None,
        speech_input: bool,
    ) -> Response:
        # Reserve before returning HTTP 200. threading.Lock is not owner-thread
        # bound; ExitStack retains the same bounded admission through WSGI close.
        resources = ExitStack()
        resources.callback(audio_path.unlink, missing_ok=True)
        try:
            resources.enter_context(state.admit())
            if speech_input:
                audio_path = speech_frontend(audio_path)
                resources.callback(audio_path.unlink, missing_ok=True)
            events = backend.transcribe_stream(audio_path, language=language, prompt=prompt)
            resources.callback(events.close)

            def generate() -> Iterator[bytes]:
                try:
                    for event in events:
                        yield _sse_event(event)
                except Exception:
                    # Headers may already be sent. Never expose upstream error
                    # text or pretend that a failed stream completed normally.
                    yield _sse_event({
                        "type": "error",
                        "error": {
                            "code": "inference_failed",
                            "message": "STT inference failed",
                            "retryable": True,
                        },
                    })
                finally:
                    resources.close()

            response = Response(
                generate(), mimetype="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
            # A generator's finally does not run if it was never started.
            response.call_on_close(resources.close)
            return response
        except BaseException:
            resources.close()
            raise

    @app.post("/v1/audio/transcriptions")
    def transcribe() -> tuple[Response, int] | Response:
        audio_path: Path | None = None
        try:
            model = _validate_optional_text("model", request.form.get("model"), 128)
            if model is None:
                raise ServiceError("invalid_request", "model is required", 400, retryable=False)
            if model != backend.model_id:
                raise ServiceError("model_unavailable", "requested model is unavailable", 400, retryable=False)
            language = _validate_optional_text("language", request.form.get("language"), 35)
            prompt = _validate_optional_text("prompt", request.form.get("prompt"), 4096)
            stream = request.form.get("stream")
            if stream not in {None, "false", "true"}:
                raise ServiceError(
                    "invalid_request", "stream must be true or false", 400, retryable=False
                )
            speech_input_header = request.headers.get("X-OpenClaw-Speech-Input")
            if speech_input_header not in {None, "agent-speech"}:
                raise ServiceError(
                    "invalid_request", "speech input purpose is invalid", 400, retryable=False
                )
            speech_input = speech_input_header == "agent-speech"
            audio_path = _store_bounded_upload(max_audio_bytes=max_audio_bytes)
            if stream == "true":
                response = streaming_response(
                    audio_path, language=language, prompt=prompt, speech_input=speech_input
                )
                audio_path = None  # The response owns upload/admission cleanup.
                return response
            with state.admit():
                if speech_input:
                    processed_path = speech_frontend(audio_path)
                    audio_path.unlink(missing_ok=True)
                    audio_path = processed_path
                text = backend.transcribe(audio_path, language=language, prompt=prompt)
            return jsonify(text=text, model=backend.model_id)
        except ServiceError as error:
            return _error_response(error)
        except Exception as error:
            app.logger.error("STT inference failed error_type=%s", type(error).__name__)
            return _error_response(
                ServiceError(
                    "inference_failed",
                    "STT inference failed",
                    500,
                    retryable=True,
                )
            )
        finally:
            if audio_path is not None:
                audio_path.unlink(missing_ok=True)

    return app
