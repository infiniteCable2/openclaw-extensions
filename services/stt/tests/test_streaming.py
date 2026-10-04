from __future__ import annotations

import json
from io import BytesIO

import pytest

from openclaw_local_stt import app as app_module
from openclaw_local_stt.app import create_app


class StreamingBackend:
    model_id = "faster-whisper"
    requested_backend = "cuda"
    observed_backend = "cuda"

    def __init__(self, *, confirmed=True, text="hello\nworld", fail=False):
        self.confirmed = confirmed
        self.text = text
        self.fail = fail
        self.decoded = False
        self.closed = False

    def transcribe(self, _path, **_kwargs):
        if self.fail:
            raise ValueError("PRIVATE_ERROR")
        return self.text

    def transcribe_stream(self, path, **_kwargs):
        assert path.exists()
        try:
            if self.confirmed:
                yield {"type": "speech.confirmed"}
            self.decoded = True
            if self.fail:
                raise ValueError("PRIVATE_ERROR")
            yield {"type": "transcript.done", "text": self.text, "model": self.model_id}
        finally:
            self.closed = True


def request_data(stream="true"):
    return {
        "file": (BytesIO(b"audio"), "input.wav", "audio/wav"),
        "model": "faster-whisper",
        "stream": stream,
    }


def decode_event(chunk):
    assert chunk.startswith(b"data: ") and chunk.endswith(b"\n\n")
    return json.loads(chunk[6:-2])


def setup_service(monkeypatch, tmp_path, **kwargs):
    monkeypatch.setattr(app_module.tempfile, "tempdir", str(tmp_path))
    backend = StreamingBackend(**kwargs)
    app = create_app(backend, max_queued_requests=0)
    app.config.update(TESTING=True)
    return app, backend


def test_confirmation_precedes_decode_and_holds_admission_until_stream_closes(monkeypatch, tmp_path):
    app, backend = setup_service(monkeypatch, tmp_path)
    client = app.test_client()
    response = client.post("/v1/audio/transcriptions", data=request_data(), buffered=False)
    assert response.mimetype == "text/event-stream"
    assert response.status_code == 200
    assert decode_event(next(response.response)) == {"type": "speech.confirmed"}
    assert not backend.decoded
    assert len(list(tmp_path.glob("openclaw-stt-*"))) == 1
    assert client.get("/status").get_json()["activeRequests"] == 1
    overloaded = client.post("/v1/audio/transcriptions", data=request_data())
    assert overloaded.status_code == 429
    assert overloaded.is_json
    assert len(list(tmp_path.glob("openclaw-stt-*"))) == 1
    response.close()
    response.close()
    assert backend.closed
    assert not backend.decoded
    assert client.get("/status").get_json()["activeRequests"] == 0
    assert list(tmp_path.glob("openclaw-stt-*")) == []
    followup = client.post("/v1/audio/transcriptions", data=request_data())
    assert [decode_event(chunk) for chunk in followup.response] == [
        {"type": "speech.confirmed"},
        {"type": "transcript.done", "text": "hello\nworld", "model": "faster-whisper"},
    ]
    followup.close()
    assert list(tmp_path.glob("openclaw-stt-*")) == []


def test_streamed_agent_speech_frontend_is_owned_until_close(tmp_path):
    backend = StreamingBackend()
    processed = tmp_path / "processed.wav"

    def frontend(source, **_kwargs):
        assert source.read_bytes() == b"audio"
        processed.write_bytes(b"enhanced")
        return processed

    app = create_app(backend, speech_frontend=frontend)
    app.config.update(TESTING=True)
    response = app.test_client().post(
        "/v1/audio/transcriptions",
        data=request_data(),
        headers={"X-OpenClaw-Speech-Input": "agent-speech"},
        buffered=False,
    )
    assert processed.exists()
    assert decode_event(next(response.response)) == {"type": "speech.confirmed"}
    response.close()
    assert not processed.exists()


@pytest.mark.parametrize("confirmed", [True, False])
@pytest.mark.parametrize("fail", [True, False])
def test_terminal_empty_or_error_event_is_emitted_once(monkeypatch, tmp_path, confirmed, fail):
    app, backend = setup_service(monkeypatch, tmp_path, confirmed=confirmed, text="", fail=fail)
    response = app.test_client().post("/v1/audio/transcriptions", data=request_data())
    assert response.status_code == 200
    assert response.mimetype == "text/event-stream"
    terminal = (
        {"type": "error", "error": {
            "code": "inference_failed", "message": "STT inference failed", "retryable": True,
        }} if fail else {"type": "transcript.done", "text": "", "model": "faster-whisper"}
    )
    assert [decode_event(chunk) for chunk in response.response] == (
        ([{"type": "speech.confirmed"}] if confirmed else []) + [terminal]
    )
    response.close()
    assert backend.closed
    assert list(tmp_path.glob("openclaw-stt-*")) == []
    assert app.test_client().get("/status").get_json()["activeRequests"] == 0


def test_unstarted_response_releases_upload_and_admission(monkeypatch, tmp_path):
    app, backend = setup_service(monkeypatch, tmp_path)
    with app.test_request_context("/v1/audio/transcriptions", method="POST", data=request_data()):
        response = app.full_dispatch_request()
        assert response.mimetype == "text/event-stream"
        assert len(list(tmp_path.glob("openclaw-stt-*"))) == 1
        response.close()
        response.close()
    assert not backend.decoded
    assert list(tmp_path.glob("openclaw-stt-*")) == []
    assert app.test_client().get("/status").get_json()["activeRequests"] == 0


@pytest.mark.parametrize("stream", ["yes", "1", "", "TRUE"])
def test_stream_validation_precedes_success_headers(monkeypatch, tmp_path, stream):
    app, backend = setup_service(monkeypatch, tmp_path)
    response = app.test_client().post("/v1/audio/transcriptions", data=request_data(stream))
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_request"
    assert not backend.decoded
    assert list(tmp_path.glob("openclaw-stt-*")) == []


@pytest.mark.parametrize("fail", [False, True])
def test_explicit_false_keeps_json_response_and_error_status(monkeypatch, tmp_path, fail):
    app, _backend = setup_service(monkeypatch, tmp_path, fail=fail)
    response = app.test_client().post("/v1/audio/transcriptions", data=request_data("false"))
    assert response.is_json
    assert response.status_code == (500 if fail else 200)
    if not fail:
        assert response.get_json() == {"text": "hello\nworld", "model": "faster-whisper"}
    assert list(tmp_path.glob("openclaw-stt-*")) == []
