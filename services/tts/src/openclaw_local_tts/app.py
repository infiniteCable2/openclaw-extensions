from __future__ import annotations

import logging
import struct
import time
from contextlib import ExitStack
from typing import Iterator

from flask import Flask, Response, jsonify, request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from .audio import join_speech_segments
from .speech_segments import split_speech_text
from .types import AudioEncoder, RenderedPcm, SynthesisBackend
from .request_lifecycle import RequestRegistry, RequestWork, ServiceError, ServiceState

_ALLOWED_FORMATS = {"opus", "pcm", "wav"}
_ALLOWED_SAMPLE_RATES = {8_000, 16_000, 24_000, 48_000}
_REQUEST_FIELDS = {"input", "model", "voice", "response_format", "sample_rate"}
_MAX_STREAM_BYTES = 64 * 1024 * 1024


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


def _parse_synthesis_request(
    backend: SynthesisBackend,
    *,
    max_text_characters: int,
) -> tuple[str, str, str, int | None]:
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
    return text, voice, output_format, sample_rate


def _append_pause(rendered: RenderedPcm, pause_ms: int) -> RenderedPcm:
    if not rendered.data or len(rendered.data) % 2:
        raise ValueError("rendered speech segment PCM is empty or incomplete")
    if pause_ms < 0 or pause_ms > 2000:
        raise ValueError("rendered speech segment pause is invalid")
    silence = b"\x00\x00" * (rendered.sample_rate * pause_ms // 1000)
    return RenderedPcm(data=rendered.data + silence, sample_rate=rendered.sample_rate)


def create_app(
    backend: SynthesisBackend,
    encoder: AudioEncoder,
    *,
    max_text_characters: int = 4096,
    max_queued_requests: int = 2,
    request_timeout_ms: int = 300_000,
) -> Flask:
    if max_text_characters < 10 or max_text_characters > 65_536:
        raise ValueError("max_text_characters is outside its allowed range")
    if max_queued_requests < 0 or max_queued_requests > 64:
        raise ValueError("max_queued_requests is outside its allowed range")

    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 64 * 1024
    app.logger.setLevel(logging.INFO)
    state = ServiceState(capacity=1 + max_queued_requests)
    registry = RequestRegistry(timeout_ms=request_timeout_ms)

    def render_segments(segments, *, voice: str, work: RequestWork) -> Iterator[RenderedPcm]:
        work.checkpoint()
        rendered = backend.synthesize_segments((segment.text for segment in segments), voice_id=voice)
        total_bytes = 0
        try:
            iterator = iter(rendered)
            while True:
                work.checkpoint()
                try:
                    segment = next(iterator)
                except StopIteration:
                    break
                work.checkpoint()
                total_bytes += len(segment.data)
                if total_bytes > _MAX_STREAM_BYTES:
                    raise ServiceError("payload_too_large", "rendered audio exceeds its limit", 413, retryable=False)
                yield segment
        finally:
            if callable(close := getattr(rendered, "close", None)):
                close()

    @app.post("/v1/requests/<identifier>/cancel")
    def cancel(identifier: str) -> tuple[Response, int] | Response:
        try:
            registry.cancel(identifier)
            return Response(status=204)
        except ServiceError as error:
            return _error_response(error)

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
        work: RequestWork | None = None
        output_format: str | None = None
        phase = "register"
        outcome = "failed"
        started_at = time.monotonic()
        try:
            work = registry.register(request.headers)
            phase = "parse"
            text, voice, output_format, sample_rate = _parse_synthesis_request(
                backend,
                max_text_characters=max_text_characters,
            )

            phase = "admit"
            if output_format == "opus":
                app.logger.info("TTS voice-note request_id=%s phase=admit", work.request_id)
            with state.admit(work):
                phase = "render"
                if output_format == "opus":
                    app.logger.info("TTS voice-note request_id=%s phase=render", work.request_id)
                segments = split_speech_text(text)
                rendered_segments = list(
                    render_segments(segments, voice=voice, work=work)
                )
                rendered = join_speech_segments(
                    rendered_segments,
                    [segment.pause_after_ms for segment in segments],
                )
                phase = "encode"
                if output_format == "opus":
                    app.logger.info("TTS voice-note request_id=%s phase=encode", work.request_id)
                audio = encoder.encode(
                    rendered,
                    output_format=output_format,
                    sample_rate=sample_rate,
                    checkpoint=work.checkpoint,
                )
                work.checkpoint()
            outcome = "ok"
            content_types = {
                "opus": "audio/ogg",
                "pcm": "application/octet-stream",
                "wav": "audio/wav",
            }
            return Response(audio, status=200, content_type=content_types[output_format])
        except ServiceError as error:
            outcome = error.code
            return _error_response(error)
        except BadRequest:
            outcome = "invalid_request"
            return _error_response(
                ServiceError("invalid_request", "JSON body is invalid", 400, retryable=False)
            )
        except Exception as error:
            outcome = "inference_failed"
            app.logger.error("TTS inference failed error_type=%s", type(error).__name__)
            return _error_response(
                ServiceError(
                    "inference_failed",
                    "TTS inference failed",
                    500,
                    retryable=True,
                )
            )
        finally:
            if work is not None:
                registry.finish(work)
                if output_format == "opus":
                    app.logger.info(
                        "TTS voice-note request_id=%s phase=%s outcome=%s elapsed_ms=%d",
                        work.request_id,
                        phase,
                        outcome,
                        max(0, round((time.monotonic() - started_at) * 1000)),
                    )

    @app.post("/v1/audio/speech/stream")
    def synthesize_stream() -> tuple[Response, int] | Response:
        resources = ExitStack()
        try:
            work = registry.register(request.headers)
            resources.callback(registry.finish, work)
            text, voice, output_format, sample_rate = _parse_synthesis_request(
                backend,
                max_text_characters=max_text_characters,
            )
            if output_format != "pcm":
                raise ServiceError(
                    "invalid_request",
                    "streaming response format must be pcm",
                    400,
                    retryable=False,
                )
            segments = split_speech_text(text)
            resources.enter_context(state.admit(work))

            def generate() -> Iterator[bytes]:
                total_bytes = 0
                rendered_count = 0
                try:
                    rendered_segments = render_segments(segments, voice=voice, work=work)
                    resources.callback(rendered_segments.close)
                    for index, rendered in enumerate(rendered_segments):
                        rendered_count += 1
                        pause_ms = segments[index].pause_after_ms if index < len(segments) - 1 else 0
                        audio = encoder.encode(
                            _append_pause(rendered, pause_ms),
                            output_format="pcm",
                            sample_rate=sample_rate,
                            checkpoint=work.checkpoint,
                        )
                        work.checkpoint()
                        if not audio or len(audio) % 2:
                            raise RuntimeError("streaming encoder returned incomplete PCM")
                        total_bytes += len(audio)
                        if total_bytes > _MAX_STREAM_BYTES:
                            raise RuntimeError("streaming audio exceeds the configured size limit")
                        yield struct.pack(">I", len(audio)) + audio
                    if rendered_count != len(segments):
                        raise RuntimeError("streaming backend returned incomplete segments")
                    yield b"\x00\x00\x00\x00"
                except Exception as error:
                    app.logger.error(
                        "TTS streaming inference failed error_type=%s",
                        type(error).__name__,
                    )
                    raise RuntimeError("TTS streaming inference failed") from None
                finally:
                    resources.close()

            response = Response(
                generate(),
                status=200,
                content_type="application/vnd.openclaw.pcm-stream",
                headers={
                    "X-OpenClaw-Audio-Sample-Rate": str(sample_rate or backend.sample_rate),
                },
            )
            # Unstarted WSGI generators do not execute their finally blocks.
            response.call_on_close(resources.close)
            return response
        except ServiceError as error:
            resources.close()
            return _error_response(error)
        except BadRequest:
            resources.close()
            return _error_response(
                ServiceError("invalid_request", "JSON body is invalid", 400, retryable=False)
            )
        except Exception as error:
            resources.close()
            app.logger.error("TTS stream setup failed error_type=%s", type(error).__name__)
            return _error_response(
                ServiceError(
                    "inference_failed",
                    "TTS inference failed",
                    500,
                    retryable=True,
                )
            )

    return app
