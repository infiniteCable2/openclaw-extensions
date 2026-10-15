from __future__ import annotations

import json
import threading
import time
import uuid
from io import BytesIO

import pytest

from openclaw_local_stt import app as app_module
from openclaw_local_stt.app import create_app


class StreamingBackend:
    model_id = "faster-whisper"
    requested_backend = "cuda"
    observed_backend = "cuda"

    def __init__(self, *, confirmed=True, text="hello\nworld", fail=False, gate=None):
        self.confirmed = confirmed
        self.text = text
        self.fail = fail
        self.decoded = False
        self.closed = False
        self.gate = gate
        self.closed_event = threading.Event()
        self.decoding = threading.Event()
        self.calls = 0

    def transcribe(self, _path, **_kwargs):
        if self.fail:
            raise ValueError("PRIVATE_ERROR")
        return self.text

    def transcribe_stream(self, path, checkpoint=lambda: None, **_kwargs):
        assert path.exists()
        self.calls += 1
        try:
            if self.confirmed:
                yield {"type": "speech.confirmed"}
            self.decoding.set()
            if self.gate is not None:
                while not self.gate.wait(timeout=0.01):
                    checkpoint()
            checkpoint()
            self.decoded = True
            if self.fail:
                raise ValueError("PRIVATE_ERROR")
            yield {"type": "transcript.done", "text": self.text, "model": self.model_id}
        finally:
            self.closed = True
            self.closed_event.set()


def request_data(stream="true"):
    return {
        "file": (BytesIO(b"audio"), "input.wav", "audio/wav"),
        "model": "faster-whisper",
        "stream": stream,
    }


def decode_event(chunk):
    assert chunk.startswith(b"data: ") and chunk.endswith(b"\n\n")
    return json.loads(chunk[6:-2])


def wait_until(predicate):
    limit = time.monotonic() + 2
    while not predicate() and time.monotonic() < limit:
        time.sleep(0.001)
    assert predicate()


def setup_service(monkeypatch, tmp_path, **kwargs):
    monkeypatch.setattr(app_module.tempfile, "tempdir", str(tmp_path))
    backend = StreamingBackend(**kwargs)
    app = create_app(backend, max_queued_requests=0)
    app.config.update(TESTING=True)
    return app, backend


def test_early_confirmation_precedes_complete_inference_and_close_cancels(monkeypatch, tmp_path):
    gate = threading.Event()
    app, backend = setup_service(monkeypatch, tmp_path, gate=gate)
    client = app.test_client()
    response = client.post("/v1/audio/transcriptions", data=request_data(), buffered=False)
    assert response.mimetype == "text/event-stream"
    assert response.status_code == 200
    assert decode_event(next(response.response)) == {"type": "speech.confirmed"}
    assert backend.decoding.wait(timeout=1)
    assert not backend.decoded
    assert len(list(tmp_path.glob("openclaw-stt-*"))) == 1
    assert client.get("/status").get_json()["activeRequests"] == 1
    overloaded = client.post("/v1/audio/transcriptions", data=request_data())
    assert overloaded.status_code == 429
    assert overloaded.is_json
    assert len(list(tmp_path.glob("openclaw-stt-*"))) == 1
    response.close()
    response.close()
    assert backend.closed_event.wait(timeout=1)
    assert backend.closed
    assert not backend.decoded
    wait_until(lambda: client.get("/status").get_json()["activeRequests"] == 0)
    wait_until(lambda: not list(tmp_path.glob("openclaw-stt-*")))
    wait_until(lambda: client.get("/status").get_json()["inFlightRequests"] == 0)
    gate.set()
    followup = client.post("/v1/audio/transcriptions", data=request_data())
    assert [decode_event(chunk) for chunk in followup.response] == [
        {"type": "speech.confirmed"},
        {"type": "transcript.done", "text": "hello\nworld", "model": "faster-whisper"},
    ]
    followup.close()
    assert list(tmp_path.glob("openclaw-stt-*")) == []


def test_streamed_agent_speech_frontend_is_owned_until_close(tmp_path):
    backend = StreamingBackend(gate=threading.Event())
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
    assert backend.closed_event.wait(timeout=1)
    wait_until(lambda: not processed.exists())


def test_slow_consumer_does_not_hold_compute_but_still_occupies_bounded_capacity(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module.tempfile, "tempdir", str(tmp_path))
    backend = StreamingBackend()
    app = create_app(backend, max_queued_requests=1)
    app.config.update(TESTING=True)
    client = app.test_client()
    first = client.post("/v1/audio/transcriptions", data=request_data(), buffered=False)
    assert decode_event(next(first.response)) == {"type": "speech.confirmed"}
    assert backend.closed_event.wait(timeout=1)
    wait_until(lambda: client.get("/status").get_json()["activeRequests"] == 0)
    assert client.get("/status").get_json()["inFlightRequests"] == 1
    # First still has an unread final event: a different request can use the model.
    backend.closed_event.clear()
    second = client.post("/v1/audio/transcriptions", data=request_data(), buffered=False)
    assert backend.closed_event.wait(timeout=1)
    assert backend.calls == 2
    third = client.post("/v1/audio/transcriptions", data=request_data())
    assert third.status_code == 429
    assert [decode_event(chunk)["type"] for chunk in first.response] == ["transcript.done"]
    first.close()
    assert [decode_event(chunk)["type"] for chunk in second.response] == [
        "speech.confirmed", "transcript.done",
    ]
    second.close()
    assert list(tmp_path.glob("openclaw-stt-*")) == []


def test_disconnect_cannot_release_capacity_until_running_decoder_retires(tmp_path):
    entered = threading.Event()
    release = threading.Event()
    finished = threading.Event()

    class NonPreemptibleBackend(StreamingBackend):
        def transcribe_stream(self, path, checkpoint=lambda: None, **_kwargs):
            try:
                yield {"type": "speech.confirmed"}
                entered.set()
                assert release.wait(timeout=2)
                assert path.exists()
                checkpoint()
                yield {"type": "transcript.done", "text": "done"}
            finally:
                finished.set()

    app = create_app(NonPreemptibleBackend(), max_queued_requests=0)
    app.config.update(TESTING=True)
    client = app.test_client()
    response = client.post("/v1/audio/transcriptions", data=request_data(), buffered=False)
    assert entered.wait(timeout=1)
    response.close()
    assert client.get("/status").get_json()["activeRequests"] == 1
    assert client.post("/v1/audio/transcriptions", data=request_data()).status_code == 429
    release.set()
    assert finished.wait(timeout=1)
    limit = time.monotonic() + 1
    while client.get("/status").get_json()["activeRequests"] and time.monotonic() < limit:
        time.sleep(0.001)
    assert client.get("/status").get_json()["activeRequests"] == 0


def test_cancellation_discards_prefetched_transcript(monkeypatch, tmp_path):
    app, backend = setup_service(monkeypatch, tmp_path)
    client = app.test_client()
    identifier = str(uuid.uuid4())
    response = client.post(
        "/v1/audio/transcriptions", data=request_data(), buffered=False,
        headers={"X-OpenClaw-Request-Id": identifier},
    )
    assert decode_event(next(response.response))["type"] == "speech.confirmed"
    assert backend.closed_event.wait(timeout=1)
    assert client.post(f"/v1/requests/{identifier}/cancel").status_code == 204
    remaining = [decode_event(chunk) for chunk in response.response]
    assert len(remaining) == 1
    assert remaining[0]["error"]["code"] == "cancelled"
    response.close()


def test_fifo_whole_utterance_compute_is_not_interleaved_by_sse_consumers(monkeypatch, tmp_path):
    monkeypatch.setattr(app_module.tempfile, "tempdir", str(tmp_path))
    first_decoding = threading.Event()
    release_first = threading.Event()
    order = []

    class OrderedBackend(StreamingBackend):
        def transcribe_stream(self, path, prompt=None, checkpoint=lambda: None, **_kwargs):
            order.append((prompt, "start"))
            try:
                yield {"type": "speech.confirmed"}
                if prompt == "first":
                    first_decoding.set()
                    assert release_first.wait(timeout=2)
                checkpoint()
                yield {"type": "transcript.done", "text": prompt}
            finally:
                order.append((prompt, "end"))

    app = create_app(OrderedBackend(), max_queued_requests=1)
    app.config.update(TESTING=True)
    data = request_data()
    data["prompt"] = "first"
    first = app.test_client().post("/v1/audio/transcriptions", data=data, buffered=False)
    assert first_decoding.wait(timeout=1)
    second_result = []

    def request_second():
        data = request_data()
        data["prompt"] = "second"
        response = app.test_client().post("/v1/audio/transcriptions", data=data)
        second_result.extend(decode_event(chunk) for chunk in response.response)
        response.close()

    second = threading.Thread(target=request_second)
    second.start()
    wait_until(lambda: app.test_client().get("/status").get_json()["queueDepth"] == 1)
    assert order == [("first", "start")]
    release_first.set()
    second.join(timeout=2)
    assert not second.is_alive()
    assert order == [("first", "start"), ("first", "end"), ("second", "start"), ("second", "end")]
    assert [event["type"] for event in second_result] == ["speech.confirmed", "transcript.done"]
    assert decode_event(next(first.response)) == {"type": "speech.confirmed"}
    assert [decode_event(chunk) for chunk in first.response] == [{"type": "transcript.done", "text": "first"}]
    first.close()


@pytest.mark.parametrize("cancel", [True, False])
def test_queued_stream_cancellation_or_deadline_never_enters_second_decoder(monkeypatch, tmp_path, cancel):
    gate = threading.Event()
    monkeypatch.setattr(app_module.tempfile, "tempdir", str(tmp_path))
    backend = StreamingBackend(gate=gate)
    app = create_app(backend, max_queued_requests=1)
    app.config.update(TESTING=True)
    first = app.test_client().post("/v1/audio/transcriptions", data=request_data(), buffered=False)
    assert backend.decoding.wait(timeout=1)
    identifier = str(uuid.uuid4())
    second_events = []

    def request_second():
        response = app.test_client().post(
            "/v1/audio/transcriptions", data=request_data(),
            headers={
                "X-OpenClaw-Request-Id": identifier,
                "X-OpenClaw-Request-Timeout-Ms": "2000" if cancel else "100",
            },
        )
        second_events.extend(decode_event(chunk) for chunk in response.response)
        response.close()

    second = threading.Thread(target=request_second)
    second.start()
    wait_until(lambda: app.test_client().get("/status").get_json()["queueDepth"] == 1)
    if cancel:
        assert app.test_client().post(f"/v1/requests/{identifier}/cancel").status_code == 204
    second.join(timeout=2)
    assert not second.is_alive()
    assert len(second_events) == 1
    assert second_events[0]["error"]["code"] == ("cancelled" if cancel else "deadline_exceeded")
    assert backend.calls == 1
    first.close()
    assert backend.closed_event.wait(timeout=1)
    wait_until(lambda: not list(tmp_path.glob("openclaw-stt-*")))


@pytest.mark.parametrize("overflow", ["bytes", "events"])
def test_event_output_limits_fail_closed_and_release_compute(monkeypatch, tmp_path, overflow):
    monkeypatch.setattr(app_module.tempfile, "tempdir", str(tmp_path))

    class ExcessiveBackend(StreamingBackend):
        def transcribe_stream(self, path, **_kwargs):
            assert path.exists()
            if overflow == "bytes":
                yield {"type": "transcript.done", "text": "x" * (1024 * 1024)}
            else:
                for _ in range(257):
                    yield {"type": "speech.confirmed"}

    app = create_app(ExcessiveBackend())
    app.config.update(TESTING=True)
    client = app.test_client()
    response = client.post("/v1/audio/transcriptions", data=request_data())
    events = [decode_event(chunk) for chunk in response.response]
    assert events[-1]["type"] == "error"
    assert events[-1]["error"]["code"] == "output_too_large"
    assert all(event["type"] != "transcript.done" for event in events)
    response.close()
    assert client.get("/status").get_json()["activeRequests"] == 0
    assert list(tmp_path.glob("openclaw-stt-*")) == []


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
