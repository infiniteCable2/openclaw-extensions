from __future__ import annotations

from io import BytesIO
from pathlib import Path

import pytest

from openclaw_local_stt.app import create_app


class FakeBackend:
    model_id = "faster-whisper"
    requested_backend = "cuda"
    observed_backend = "cuda"

    def __init__(self) -> None:
        self.calls: list[tuple[bytes, str | None, str | None, str]] = []

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None,
        prompt: str | None,
    ) -> str:
        self.calls.append((audio_path.read_bytes(), language, prompt, audio_path.suffix))
        return "Hallo Welt"


@pytest.fixture
def service():
    backend = FakeBackend()
    app = create_app(backend, max_audio_bytes=2048, max_queued_requests=1)
    app.config.update(TESTING=True)
    return app.test_client(), backend


def test_liveness_and_readiness_are_content_free(service) -> None:
    client, _backend = service
    assert client.get("/live").get_json() == {"live": True}
    ready = client.get("/ready").get_json()
    assert ready == {
        "activeRequests": 0,
        "model": "faster-whisper",
        "observedBackend": "cuda",
        "queueDepth": 0,
        "ready": True,
        "requestedBackend": "cuda",
        "state": "ready",
    }


def test_openai_compatible_transcription(service) -> None:
    client, backend = service
    response = client.post(
        "/v1/audio/transcriptions",
        data={
            "file": (BytesIO(b"audio-bytes"), "message.ogg", "audio/ogg"),
            "model": "faster-whisper",
            "language": "de",
            "prompt": "Eigennamen",
        },
    )
    assert response.status_code == 200
    assert response.get_json() == {"model": "faster-whisper", "text": "Hallo Welt"}
    assert backend.calls == [(b"audio-bytes", "de", "Eigennamen", ".ogg")]


def test_only_agent_speech_uses_frontend(tmp_path) -> None:
    backend = FakeBackend()
    calls: list[bytes] = []

    def frontend(source: Path) -> Path:
        calls.append(source.read_bytes())
        processed = tmp_path / "processed.wav"
        processed.write_bytes(b"enhanced")
        return processed

    app = create_app(backend, speech_frontend=frontend)
    app.config.update(TESTING=True)
    client = app.test_client()
    data = lambda: {
        "file": (BytesIO(b"original"), "voice.ogg", "audio/ogg"),
        "model": "faster-whisper",
    }
    assert client.post("/v1/audio/transcriptions", data=data()).status_code == 200
    assert calls == []
    assert backend.calls[-1][0] == b"original"
    response = client.post(
        "/v1/audio/transcriptions",
        data=data(),
        headers={"X-OpenClaw-Speech-Input": "agent-speech"},
    )
    assert response.status_code == 200
    assert calls == [b"original"]
    assert backend.calls[-1][0] == b"enhanced"
    assert not (tmp_path / "processed.wav").exists()
    assert client.post(
        "/v1/audio/transcriptions",
        data=data(),
        headers={"X-OpenClaw-Speech-Input": "relay"},
    ).status_code == 400


@pytest.mark.parametrize(
    ("filename", "content_type", "expected_suffix"),
    [
        ("message.wav", "audio/wav", ".wav"),
        ("message.MP3", "audio/mpeg", ".mp3"),
        ("message.webm", "application/octet-stream", ".webm"),
        ("../../message.exe", "application/octet-stream", ".audio"),
    ],
)
def test_upload_uses_safe_decoder_suffix(service, filename, content_type, expected_suffix) -> None:
    client, backend = service
    response = client.post(
        "/v1/audio/transcriptions",
        data={
            "file": (BytesIO(b"audio-bytes"), filename, content_type),
            "model": "faster-whisper",
        },
    )
    assert response.status_code == 200
    assert backend.calls[-1][3] == expected_suffix


@pytest.mark.parametrize(
    ("data", "code"),
    [
        ({"model": "faster-whisper"}, "invalid_request"),
        ({"file": (BytesIO(b"audio"), "a.ogg", "audio/ogg")}, "invalid_request"),
        (
            {
                "file": (BytesIO(b"audio"), "a.ogg", "audio/ogg"),
                "model": "other-model",
            },
            "model_unavailable",
        ),
        (
            {
                "file": (BytesIO(b"audio"), "a.txt", "text/plain"),
                "model": "faster-whisper",
            },
            "unsupported_media",
        ),
    ],
)
def test_invalid_requests_are_bounded(service, data, code) -> None:
    client, _backend = service
    response = client.post("/v1/audio/transcriptions", data=data)
    assert response.status_code == 400
    error = response.get_json()["error"]
    assert error["code"] == code
    assert error["retryable"] is False
    assert 0 < len(error["message"]) <= 512


def test_oversized_audio_is_rejected(service) -> None:
    client, backend = service
    response = client.post(
        "/v1/audio/transcriptions",
        data={
            "file": (BytesIO(b"x" * 2049), "large.wav", "audio/wav"),
            "model": "faster-whisper",
        },
    )
    assert response.status_code == 413
    assert response.get_json()["error"]["code"] == "payload_too_large"
    assert backend.calls == []
