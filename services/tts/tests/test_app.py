from __future__ import annotations

import pytest

from openclaw_local_tts.app import create_app
from openclaw_local_tts.types import RenderedPcm


class FakeBackend:
    model_id = "chatterbox"
    default_voice = "astrid"
    voice_ids = frozenset({"astrid", "nova"})
    requested_backend = "cuda"
    observed_backend = "cuda"

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def synthesize(self, text: str, *, voice_id: str) -> RenderedPcm:
        self.calls.append((text, voice_id))
        return RenderedPcm(data=b"\x00\x00\x01\x00", sample_rate=24_000)


class FakeEncoder:
    def __init__(self) -> None:
        self.calls: list[tuple[RenderedPcm, str, int | None]] = []

    def encode(
        self,
        rendered: RenderedPcm,
        *,
        output_format: str,
        sample_rate: int | None,
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
        "acceleratorLease": "disabled",
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
