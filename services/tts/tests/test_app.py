from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Iterator

import pytest

from openclaw_local_tts.app import create_app
from openclaw_local_tts.types import RenderedPcm


class FakeBackend:
    model_id = "chatterbox"
    default_voice = "astrid"
    voice_ids = frozenset({"astrid", "nova"})
    public_voices = (
        {"id": "astrid", "name": "Astrid", "locale": "de-DE"},
        {"id": "nova", "name": "Nova"},
    )
    requested_backend = "cuda"
    observed_backend = "cuda"
    sample_rate = 24_000

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def synthesize(self, text: str, *, voice_id: str) -> RenderedPcm:
        self.calls.append((text, voice_id))
        return RenderedPcm(data=b"\x00\x00\x01\x00", sample_rate=24_000)

    def synthesize_segments(
        self,
        texts: Iterable[str],
        *,
        voice_id: str,
    ) -> Iterator[RenderedPcm]:
        for text in texts:
            yield self.synthesize(text, voice_id=voice_id)


class FakeEncoder:
    def __init__(self) -> None:
        self.calls: list[tuple[RenderedPcm, str, int | None]] = []

    def encode(
        self,
        rendered: RenderedPcm,
        *,
        output_format: str,
        sample_rate: int | None,
        checkpoint=lambda: None,
    ) -> bytes:
        self.calls.append((rendered, output_format, sample_rate))
        return f"encoded-{output_format}-{sample_rate}".encode()


@pytest.fixture
def service():
    backend = FakeBackend()
    encoder = FakeEncoder()
    app = create_app(backend, encoder, max_text_characters=100, max_queued_requests=1)
    app.config.update(TESTING=True)
    return app.test_client(), backend, encoder


def test_liveness_and_readiness_are_content_free(service) -> None:
    client, _backend, _encoder = service
    assert client.get("/live").get_json() == {"live": True}
    assert client.get("/ready").get_json() == {
        "activeRequests": 0,
        "model": "chatterbox",
        "observedBackend": "cuda",
        "queueDepth": 0,
        "ready": True,
        "requestedBackend": "cuda",
        "state": "ready",
    }


def test_voice_note_uses_selected_voice_without_reloading_model(service) -> None:
    client, backend, encoder = service
    first = client.post(
        "/v1/audio/speech",
        json={
            "input": "Hallo",
            "model": "chatterbox",
            "voice": "astrid",
            "response_format": "opus",
        },
    )
    second = client.post(
        "/v1/audio/speech",
        json={
            "input": "Guten Tag",
            "model": "chatterbox",
            "voice": "nova",
            "response_format": "opus",
        },
    )
    assert first.status_code == second.status_code == 200
    assert first.content_type == second.content_type == "audio/ogg"
    assert backend.calls == [("Hallo", "astrid"), ("Guten Tag", "nova")]
    assert [call[1:] for call in encoder.calls] == [("opus", None), ("opus", None)]


def test_voice_note_diagnostics_do_not_log_speech_content(service, caplog) -> None:
    client, _backend, _encoder = service
    request_id = "123e4567-e89b-42d3-a456-426614174000"
    with caplog.at_level(logging.INFO):
        response = client.post(
            "/v1/audio/speech",
            json={
                "input": "PRIVATE_SYNTHETIC_TEXT",
                "model": "chatterbox",
                "voice": "nova",
                "response_format": "opus",
            },
            headers={"X-OpenClaw-Request-Id": request_id},
        )

    assert response.status_code == 200
    messages = [record.getMessage() for record in caplog.records]
    assert any(f"request_id={request_id} phase=render" in message for message in messages)
    assert any(f"request_id={request_id} phase=encode" in message for message in messages)
    assert any(f"request_id={request_id} phase=encode outcome=ok" in message for message in messages)
    assert all("PRIVATE_SYNTHETIC_TEXT" not in message for message in messages)


def test_voice_catalog_is_public_but_contains_no_reference_paths(service) -> None:
    client, _backend, _encoder = service
    response = client.get("/v1/voices")

    assert response.status_code == 200
    assert response.get_json() == {
        "object": "list",
        "model": "chatterbox",
        "default_voice": "astrid",
        "data": [
            {"id": "astrid", "name": "Astrid", "locale": "de-DE"},
            {"id": "nova", "name": "Nova"},
        ],
    }
    assert "path" not in response.get_data(as_text=True).lower()


def test_telephony_requests_fixed_rate_pcm(service) -> None:
    client, _backend, encoder = service
    response = client.post(
        "/v1/audio/speech",
        json={
            "input": "Guten Tag",
            "model": "chatterbox",
            "voice": "astrid",
            "response_format": "pcm",
            "sample_rate": 16000,
        },
    )
    assert response.status_code == 200
    assert response.content_type == "application/octet-stream"
    assert encoder.calls[0][1:] == ("pcm", 16000)


def test_telephony_stream_yields_ordered_segments_before_the_request_finishes() -> None:
    class StreamingEncoder(FakeEncoder):
        def encode(
            self,
            rendered: RenderedPcm,
            *,
            output_format: str,
            sample_rate: int | None,
            checkpoint=lambda: None,
        ) -> bytes:
            self.calls.append((rendered, output_format, sample_rate))
            return rendered.data

    backend = FakeBackend()
    encoder = StreamingEncoder()
    app = create_app(backend, encoder, max_text_characters=1000)
    app.config.update(TESTING=True)
    text = " ".join(
        [
            "Der erste Abschnitt enthält genügend Wörter für ein frühes Sprachsegment.",
            "Der zweite Abschnitt folgt danach und darf den ersten nicht verzögern.",
            "Ein dritter Abschnitt bestätigt die korrekte Reihenfolge der Ausgabe.",
            "Zum Abschluss bleibt auch die konfigurierte Stimme über alle Segmente gleich.",
        ]
    )

    response = app.test_client().post(
        "/v1/audio/speech/stream",
        json={
            "input": text,
            "model": "chatterbox",
            "voice": "nova",
            "response_format": "pcm",
            "sample_rate": 16000,
        },
        buffered=False,
    )
    iterator = iter(response.response)
    first_frame = next(iterator)

    assert response.status_code == 200
    assert response.content_type == "application/vnd.openclaw.pcm-stream"
    assert response.headers["X-OpenClaw-Audio-Sample-Rate"] == "16000"
    assert len(backend.calls) == 1
    assert int.from_bytes(first_frame[:4], "big") == len(first_frame) - 4
    remaining = list(iterator)
    assert remaining[-1] == b"\x00\x00\x00\x00"
    assert len(backend.calls) > 1
    assert {voice for _text, voice in backend.calls} == {"nova"}
    assert len(encoder.calls) == len(backend.calls)


def test_telephony_stream_rejects_non_pcm_without_starting_inference(service) -> None:
    client, backend, _encoder = service
    response = client.post(
        "/v1/audio/speech/stream",
        json={
            "input": "Guten Tag",
            "model": "chatterbox",
            "voice": "astrid",
            "response_format": "opus",
        },
    )

    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_request"
    assert backend.calls == []


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({}, "invalid_request"),
        (
            {
                "input": "text",
                "model": "wrong",
                "voice": "astrid",
                "response_format": "opus",
            },
            "model_unavailable",
        ),
        (
            {
                "input": "text",
                "model": "chatterbox",
                "voice": "unknown",
                "response_format": "opus",
            },
            "invalid_request",
        ),
        (
            {
                "input": "text",
                "model": "chatterbox",
                "voice": "astrid",
                "response_format": "mp3",
            },
            "invalid_request",
        ),
        (
            {
                "input": "text",
                "model": "chatterbox",
                "voice": "astrid",
                "response_format": "pcm",
                "sample_rate": 44100,
            },
            "invalid_request",
        ),
        (
            {
                "input": "text",
                "model": "chatterbox",
                "voice": "astrid",
                "response_format": "opus",
                "unexpected": True,
            },
            "invalid_request",
        ),
    ],
)
def test_invalid_requests_fail_closed(service, body, code) -> None:
    client, backend, _encoder = service
    response = client.post("/v1/audio/speech", json=body)
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == code
    assert backend.calls == []


def test_text_limit_is_enforced_before_synthesis(service) -> None:
    client, backend, _encoder = service
    response = client.post(
        "/v1/audio/speech",
        json={
            "input": "x" * 101,
            "model": "chatterbox",
            "voice": "astrid",
            "response_format": "wav",
        },
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_request"
    assert backend.calls == []


def test_long_speech_is_segmented_in_order_and_encoded_once() -> None:
    backend = FakeBackend()
    encoder = FakeEncoder()
    app = create_app(backend, encoder, max_text_characters=1000)
    app.config.update(TESTING=True)
    client = app.test_client()
    text = " ".join(
        [
            "Der erste Abschnitt beschreibt den Anfang einer längeren Sprachausgabe ausführlich.",
            "Danach folgt ein zweiter Satz mit weiteren nützlichen Einzelheiten für den Hörer.",
            "Zum Abschluss stellt ein dritter Satz sicher, dass kein Inhalt verloren geht.",
        ]
    )

    response = client.post(
        "/v1/audio/speech",
        json={
            "input": text,
            "model": "chatterbox",
            "voice": "nova",
            "response_format": "opus",
        },
    )

    assert response.status_code == 200
    assert len(backend.calls) > 1
    assert {voice for _chunk, voice in backend.calls} == {"nova"}
    source_words = re.findall(r"\b\w+\b", text, flags=re.UNICODE)
    rendered_words = [
        word
        for chunk, _voice in backend.calls
        for word in re.findall(r"\b\w+\b", chunk, flags=re.UNICODE)
    ]
    assert rendered_words == source_words
    assert len(encoder.calls) == 1


def test_failed_segment_never_returns_partial_audio() -> None:
    class FailingBackend(FakeBackend):
        def synthesize(self, text: str, *, voice_id: str) -> RenderedPcm:
            if self.calls:
                raise RuntimeError("synthetic segment failure")
            return super().synthesize(text, voice_id=voice_id)

    backend = FailingBackend()
    encoder = FakeEncoder()
    app = create_app(backend, encoder, max_text_characters=1000)
    app.config.update(TESTING=True)
    response = app.test_client().post(
        "/v1/audio/speech",
        json={
            "input": " ".join(f"Wort{index}." for index in range(50)),
            "model": "chatterbox",
            "voice": "nova",
            "response_format": "opus",
        },
    )

    assert response.status_code == 500
    assert response.get_json()["error"]["code"] == "inference_failed"
    assert encoder.calls == []


def test_unstarted_stream_close_releases_admission_and_retires_request():
    from uuid import uuid4
    backend = FakeBackend()
    app = create_app(backend, FakeEncoder(), max_queued_requests=0)
    identifier = str(uuid4())
    body = {"input": "Hallo", "model": "chatterbox", "voice": "nova", "response_format": "pcm"}
    with app.test_request_context(
        "/v1/audio/speech/stream", method="POST", json=body,
        headers={"X-OpenClaw-Request-Id": identifier},
    ):
        response = app.full_dispatch_request()
        assert response.status_code == 200
        assert backend.calls == []
        assert app.test_client().get("/status").get_json()["activeRequests"] == 1
        response.close()
        response.close()
    assert app.test_client().get("/status").get_json()["activeRequests"] == 0
    assert app.test_client().post(
        "/v1/audio/speech", json=body, headers={"X-OpenClaw-Request-Id": identifier},
    ).status_code == 409
    assert app.test_client().post("/v1/audio/speech", json=body).status_code == 200


def test_cancelled_tts_stops_before_next_segment():
    from uuid import uuid4
    identifier = str(uuid4())
    class CancellingBackend(FakeBackend):
        def synthesize(self, text, *, voice_id):
            rendered = super().synthesize(text, voice_id=voice_id)
            app.test_client().post(f"/v1/requests/{identifier}/cancel")
            return rendered
    backend = CancellingBackend()
    app = create_app(backend, FakeEncoder(), max_text_characters=1000)
    response = app.test_client().post(
        "/v1/audio/speech", headers={"X-OpenClaw-Request-Id": identifier},
        json={"input": "Langer Beispielsatz mit mehreren Wörtern für einen eigenen Abschnitt. " * 8,
              "model": "chatterbox", "voice": "nova", "response_format": "pcm"},
    )
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "cancelled"
    assert len(backend.calls) == 1
    assert app.test_client().get("/status").get_json()["activeRequests"] == 0


def test_precancelled_tts_request_never_runs(service):
    from uuid import uuid4
    client, backend, _ = service
    identifier = str(uuid4())
    assert client.post(f"/v1/requests/{identifier}/cancel").status_code == 204
    response = client.post(
        "/v1/audio/speech", headers={"X-OpenClaw-Request-Id": identifier},
        json={"input": "Hallo", "model": "chatterbox", "voice": "nova", "response_format": "pcm"},
    )
    assert response.status_code == 409
    assert backend.calls == []
