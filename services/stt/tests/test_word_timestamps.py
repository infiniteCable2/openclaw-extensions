from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from io import BytesIO
import json
import sys
import threading
from types import SimpleNamespace
import uuid

import pytest

from openclaw_local_stt import app as app_module
from openclaw_local_stt import backend as backend_module
from openclaw_local_stt.backend import FasterWhisperBackend
from openclaw_local_stt.request_lifecycle import ServiceError, ServiceState


def whisper(monkeypatch, tmp_path, word, *, segments=None):
    calls = []
    def transcribe(_audio, **kwargs):
        calls.append(kwargs)
        return iter(segments if segments is not None else [SimpleNamespace(text=" Hallo", words=[word])]), SimpleNamespace(
            duration=2.0, duration_after_vad=0.4,
        )
    model = SimpleNamespace(model=SimpleNamespace(device="cuda"), transcribe=transcribe)
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(
        WhisperModel=lambda *_args, **_kwargs: model,
    ))
    monkeypatch.setattr(backend_module, "decode_bounded_audio", lambda *_args, **_kwargs: "audio")
    return FasterWhisperBackend(model_path=tmp_path), calls


def test_whisper_optional_words_preserve_original_silence_time(monkeypatch, tmp_path):
    word = SimpleNamespace(word=" Hallo", start=1.2, end=1.6, probability=0.9)
    backend, calls = whisper(monkeypatch, tmp_path, word)
    done = list(backend.transcribe_stream(
        tmp_path / "clip.wav", language="de", prompt=None, word_timestamps=True,
    ))[-1]
    assert done["words"] == [{"word": " Hallo", "start": 1.2, "end": 1.6, "probability": 0.9}]
    assert done["duration"] == 2.0
    assert calls[0]["word_timestamps"] is True
    # No rebase onto duration_after_vad, no text normalization, no extra default option.
    normal = list(backend.transcribe_stream(tmp_path / "clip.wav", language="de", prompt=None))[-1]
    assert "words" not in normal and "duration" not in normal
    assert "word_timestamps" not in calls[1]


@pytest.mark.parametrize("start,end,probability", [
    (float("nan"), 1, 0.8), (True, 1, 0.8), (-1, 1, 0.8),
    (1.5, 1, 0.8), (0, 3, 0.8), (0, 1, 1.1),
])
def test_whisper_rejects_invalid_optional_metadata(monkeypatch, tmp_path, start, end, probability):
    backend, _ = whisper(monkeypatch, tmp_path, SimpleNamespace(
        word="example", start=start, end=end, probability=probability,
    ))
    with pytest.raises(ServiceError) as error:
        list(backend.transcribe_stream(tmp_path / "clip.wav", language=None, prompt=None, word_timestamps=True))
    assert error.value.code == "timing_unavailable"


def test_background_duration_refused_before_model_inference(monkeypatch, tmp_path):
    backend, calls = whisper(monkeypatch, tmp_path, SimpleNamespace(word="x", start=0, end=1))
    def refuse(_path, *, checkpoint, max_seconds):
        assert max_seconds == 8
        checkpoint()
        raise ServiceError("payload_too_large", "decoded duration exceeded", 413, retryable=False)
    monkeypatch.setattr(backend_module, "decode_bounded_audio", refuse)
    with pytest.raises(ServiceError) as error:
        list(backend.transcribe_stream(tmp_path/'clip.wav', language=None, prompt=None,
                                      word_timestamps=True, max_audio_seconds=8))
    assert error.value.code == "payload_too_large"
    assert calls == []


def test_absent_probability_is_not_fabricated(monkeypatch, tmp_path):
    backend, _ = whisper(monkeypatch, tmp_path, SimpleNamespace(word="x", start=0, end=1))
    result = list(backend.transcribe_stream(tmp_path/'clip.wav', language=None, prompt=None,
                                          word_timestamps=True))[-1]
    assert result['words'] == [{'word': 'x', 'start': 0.0, 'end': 1.0}]


class TimingBackend:
    model_id = "faster-whisper"
    requested_backend = observed_backend = "cuda"

    def __init__(self):
        self.entered = threading.Event()
        self.resume = threading.Event()
        self.lock = threading.Lock()
        self.active = self.peak = 0
        self.calls = []
        self.analysis_limits = []

    @contextmanager
    def run(self, path, timed, checkpoint):
        value = path.read_bytes().decode()
        with self.lock:
            self.active += 1
            self.peak = max(self.peak, self.active)
            self.calls.append((value, timed))
        try:
            if value == "blocked":
                self.entered.set()
                assert self.resume.wait(5), "test inference was not released"
            checkpoint()
            yield value
        finally:
            with self.lock:
                self.active -= 1

    def transcribe(self, path, *, checkpoint=lambda: None, **_kwargs):
        with self.run(path, False, checkpoint) as text:
            return text

    def transcribe_stream(self, path, *, word_timestamps=False, checkpoint=lambda: None, **_kwargs):
        self.analysis_limits.append(_kwargs.get("max_audio_seconds"))
        with self.run(path, word_timestamps, checkpoint) as text:
            yield {"type": "speech.confirmed"}
            yield {"type": "transcript.done", "text": text, "model": self.model_id,
                   **({"words": [{"word": text, "start": 0.2, "end": 0.7}], "duration": 1.0}
                      if word_timestamps else {})}


def data(text="example", *, timed=False, stream=False):
    result = {"file": (BytesIO(text.encode()), "clip.wav", "audio/wav"), "model": "faster-whisper"}
    if timed:
        result.update({"timestamp_granularities[]": "word", "response_format": "verbose_json"})
    if stream:
        result["stream"] = "true"
    return result


@pytest.mark.parametrize("stream", [False, True])
def test_http_metadata_is_opt_in_and_does_not_enhance_file_audio(stream):
    backend = TimingBackend()
    def forbidden_frontend(*_args, **_kwargs):
        raise AssertionError("ordinary analysis entered agent-speech frontend")
    app = app_module.create_app(backend, speech_frontend=forbidden_frontend)
    with app.test_client() as client:
        plain = client.post("/v1/audio/transcriptions", data=data()).get_json()
        assert plain == {"text": "example", "model": backend.model_id}
        response = client.post("/v1/audio/transcriptions", data=data(timed=True, stream=stream))
        assert response.status_code == 200
        if stream:
            events = [json.loads(line[6:]) for line in response.data.decode().splitlines() if line.startswith("data: ")]
            result = events[-1]
            assert result["type"] == "transcript.done"
        else:
            result = response.get_json()
        assert result["words"] == [{"word": "example", "start": 0.2, "end": 0.7}]
        assert result["duration"] == 1.0
        assert backend.calls == [("example", False), ("example", True)]


@pytest.mark.parametrize("options", [
    {"timestamp_granularities[]": "segment", "response_format": "verbose_json"},
    {"timestamp_granularities[]": "word"},
    {"timestamp_granularities[]": ["word", "word"], "response_format": "verbose_json"},
])
def test_http_invalid_granularity_rejected_before_inference(options):
    backend = TimingBackend()
    app = app_module.create_app(backend)
    with app.test_client() as client:
        request = data()
        request.update(options)
        assert client.post("/v1/audio/transcriptions", data=request).status_code == 400
    assert backend.calls == []


@pytest.mark.parametrize("first_timed", [False, True])
def test_mixed_requests_share_one_worker_and_cancel_queued_work(monkeypatch, first_timed):
    second_reserved = threading.Event()
    class ObservedState(ServiceState):
        @contextmanager
        def compute(self, work=None):
            if self.request_count() == 2:
                second_reserved.set()
            with super().compute(work):
                yield
    monkeypatch.setattr(app_module, "ServiceState", ObservedState)
    backend = TimingBackend()
    app = app_module.create_app(backend, max_queued_requests=1)
    identifier = str(uuid.uuid4())
    def post(text, timed, headers=None):
        with app.test_client() as client:
            return client.post("/v1/audio/transcriptions", data=data(text, timed=timed), headers=headers)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(post, "blocked", first_timed)
        try:
            assert backend.entered.wait(3)
            second = executor.submit(post, "queued", not first_timed, {"X-OpenClaw-Request-Id": identifier})
            assert second_reserved.wait(3)
            assert post("overflow", True).status_code == 429
            with app.test_client() as client:
                assert client.post(f"/v1/requests/{identifier}/cancel").status_code == 204
        finally:
            backend.resume.set()
        assert first.result(timeout=3).status_code == 200
        assert second.result(timeout=3).status_code == 409
    result = post("fresh", True)
    assert result.status_code == 200 and result.get_json()["words"][0]["word"] == "fresh"
    assert backend.peak == 1
    assert backend.calls == [("blocked", first_timed), ("fresh", True)]
    with app.test_client() as client:
        assert client.get("/status").get_json()["inFlightRequests"] == 0


def test_background_analysis_skips_busy_worker_and_uses_bounded_audio_when_idle():
    backend = TimingBackend()
    app = app_module.create_app(backend, max_queued_requests=1)
    def post_first():
        with app.test_client() as client:
            return client.post("/v1/audio/transcriptions", data=data("blocked"))
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(post_first)
        try:
            assert backend.entered.wait(3)
            with app.test_client() as client:
                refused = client.post("/v1/audio/transcriptions", data=data(timed=True),
                                      headers={"X-OpenClaw-Work-Class": "background-analysis"})
                assert refused.status_code == 429
                assert backend.calls == [("blocked", False)]
        finally:
            backend.resume.set()
        assert first.result(timeout=3).status_code == 200
    with app.test_client() as client:
        accepted = client.post("/v1/audio/transcriptions", data=data(timed=True),
                               headers={"X-OpenClaw-Work-Class": "background-analysis"})
        assert accepted.status_code == 200
        assert accepted.get_json()["words"][0]["word"] == "example"
    assert backend.analysis_limits == [8]
    assert backend.peak == 1


def test_foreground_reservation_wins_before_background_compute():
    from openclaw_local_stt.request_lifecycle import RequestRegistry
    registry = RequestRegistry()
    background = registry.register({"X-OpenClaw-Work-Class": "background-analysis"})
    foreground = registry.register({})
    state = ServiceState(capacity=2)
    with state.reserve(background), state.reserve(foreground):
        with pytest.raises(ServiceError) as error:
            with state.compute(background):
                raise AssertionError("stale background admission reached compute")
        assert error.value.code == "overloaded"
        with state.compute(foreground):
            assert state.snapshot() == (1, 0)
    assert state.request_count() == 0


def test_background_cannot_fill_single_slot_service():
    backend = TimingBackend()
    app = app_module.create_app(backend, max_queued_requests=0)
    with app.test_client() as client:
        response = client.post("/v1/audio/transcriptions", data=data(timed=True),
                               headers={"X-OpenClaw-Work-Class": "background-analysis"})
        assert response.status_code == 429
        assert client.post("/v1/audio/transcriptions", data=data()).status_code == 200
    assert backend.calls == [("example", False)]


def test_background_deadline_is_capped_and_can_be_shortened(monkeypatch):
    from openclaw_local_stt import request_lifecycle as lifecycle
    clock = [10.0]
    monkeypatch.setattr(lifecycle, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    registry = lifecycle.RequestRegistry()
    background = registry.register({"X-OpenClaw-Work-Class": "background-analysis"})
    assert background.deadline == 11.5
    shorter = registry.register({"X-OpenClaw-Work-Class": "background-analysis",
                                 "X-OpenClaw-Request-Timeout-Ms": "200"})
    assert shorter.deadline == 10.2
    foreground = registry.register({})
    assert foreground.deadline == 310.0
    clock[0] = 12.0
    with pytest.raises(ServiceError) as error:
        background.checkpoint()
    assert error.value.code == "deadline_exceeded"
    foreground.checkpoint()


def test_background_tombstones_do_not_exhaust_foreground_registry(monkeypatch):
    from openclaw_local_stt import request_lifecycle as lifecycle
    clock = [10.0]
    monkeypatch.setattr(lifecycle, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    registry = lifecycle.RequestRegistry(capacity=8)
    for _ in range(2):
        registry.finish(registry.register({"X-OpenClaw-Work-Class": "background-analysis"}))
    with pytest.raises(ServiceError) as error:
        registry.register({"X-OpenClaw-Work-Class": "background-analysis"})
    assert error.value.code == "overloaded"
    foreground = [registry.register({}) for _ in range(6)]
    for work in foreground:
        registry.finish(work)
    clock[0] += 301
    work = registry.register({"X-OpenClaw-Work-Class": "background-analysis"})
    assert len(registry.background_ids) == 1
    registry.cancel(work.request_id)
    with pytest.raises(ServiceError) as error:
        work.checkpoint()
    assert error.value.code == "cancelled"


@pytest.mark.parametrize('timed,headers', [
    (False, {'X-OpenClaw-Work-Class': 'background-analysis'}),
    (True, {'X-OpenClaw-Work-Class': 'background-analysis', 'X-OpenClaw-Speech-Input': 'agent-speech'}),
    (True, {'X-OpenClaw-Work-Class': 'unknown'}),
])
def test_invalid_analysis_class_or_frontend_combination_never_runs_model(timed, headers):
    backend = TimingBackend()
    app = app_module.create_app(backend)
    with app.test_client() as client:
        assert client.post('/v1/audio/transcriptions', data=data(timed=timed), headers=headers).status_code == 400
        assert client.get('/status').get_json()['inFlightRequests'] == 0
    assert backend.calls == []


@pytest.mark.parametrize('surrounded', [False, True])
def test_nonempty_segment_without_words_is_not_success(monkeypatch, tmp_path, surrounded):
    missing = SimpleNamespace(text='missing alignment', words=[])
    segments = [missing]
    if surrounded:
        segments = [SimpleNamespace(text='first', words=[SimpleNamespace(word='first', start=0, end=0.2)]),
                    missing, SimpleNamespace(text='last', words=[SimpleNamespace(word='last', start=1, end=1.2)])]
    backend, _ = whisper(monkeypatch, tmp_path, None, segments=segments)
    with pytest.raises(ServiceError) as error:
        list(backend.transcribe_stream(tmp_path/'clip.wav', language=None, prompt=None, word_timestamps=True))
    assert error.value.code == 'timing_unavailable'


def test_verbose_limit_checks_actual_nonascii_response_bytes():
    class LargeMetadata(TimingBackend):
        def transcribe_stream(self, *_args, **_kwargs):
            words = [{'word':'汉'*256,'start':0.0,'end':1.0}]*800
            # This passes the old UTF8 estimate, but Flask's ASCII escaping
            # makes the actual JSON response larger than the promised bound.
            result = {'type':'transcript.done','text':'example','model':self.model_id,'words':words,'duration':2.0}
            assert len(json.dumps(result,ensure_ascii=False).encode()) < 1024*1024
            yield result
    app = app_module.create_app(LargeMetadata())
    with app.test_client() as client:
        response = client.post('/v1/audio/transcriptions',data=data(timed=True))
        assert response.status_code == 413
        assert response.get_json()['error']['code'] == 'output_too_large'
        assert len(response.data) < 1024*1024
