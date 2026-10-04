from __future__ import annotations

import json
import logging
import math
import sys
from types import SimpleNamespace

import pytest

from openclaw_local_stt import backend as backend_module
from openclaw_local_stt.backend import FasterWhisperBackend


def make_backend(monkeypatch, tmp_path, transcribe):
    monkeypatch.setattr(backend_module, "decode_bounded_audio", lambda path, **kwargs: str(path))
    model = SimpleNamespace(model=SimpleNamespace(device="cuda"), transcribe=transcribe)
    monkeypatch.setitem(
        sys.modules, "faster_whisper",
        SimpleNamespace(WhisperModel=lambda *_args, **_kwargs: model),
    )
    return FasterWhisperBackend(model_path=tmp_path, model_id="PRIVATE_MODEL")


def diagnostic_records(caplog):
    return [
        json.loads(record.getMessage())
        for record in caplog.records
        if record.name == "openclaw_local_stt.app"
    ]


@pytest.mark.parametrize(
    ("duration_after_vad", "texts", "expected_text"),
    [
        (0.35, [" PRIVATE_TRANSCRIPT ", " ", "second"], "PRIVATE_TRANSCRIPT second"),
        (0.0, [], ""),
        (0.35, [], ""),
    ],
)
def test_stage_diagnostics_distinguish_vad_filtering_from_empty_decode(
    monkeypatch, tmp_path, caplog, duration_after_vad, texts, expected_text
):
    clock = [0.0]
    # Replacing the clock is not a backend seam: production uses monotonic time.
    monkeypatch.setattr(backend_module, "perf_counter", lambda: clock[0], raising=False)
    calls = []

    def transcribe(path, **kwargs):
        calls.append((path, kwargs))
        clock[0] += 0.017

        def segments():
            clock[0] += 0.023
            yield from (SimpleNamespace(text=text) for text in texts)

        return segments(), SimpleNamespace(duration=1.2, duration_after_vad=duration_after_vad)

    backend = make_backend(monkeypatch, tmp_path, transcribe)
    audio_path = tmp_path / "PRIVATE_AUDIO.wav"
    with caplog.at_level(logging.INFO, logger="openclaw_local_stt.app"):
        assert backend.transcribe(
            audio_path, language="de", prompt="PRIVATE_PROMPT"
        ) == expected_text
    assert calls == [(
        str(audio_path),
        {"language": "de", "initial_prompt": "PRIVATE_PROMPT", "vad_filter": True},
    )]
    assert diagnostic_records(caplog) == [{
        "event": "local_media_stt_backend",
        "outcome": "transcribed" if expected_text else "empty",
        "vadEnabled": True,
        "durationMs": 1200,
        "durationAfterVadMs": round(duration_after_vad * 1000),
        "segmentCount": len(texts),
        "prepareMs": 17,
        "decodeMs": 23,
        "totalMs": 40,
    }]
    for private_value in (
        "PRIVATE_TRANSCRIPT", "PRIVATE_AUDIO", "PRIVATE_MODEL", "PRIVATE_PROMPT", str(tmp_path)
    ):
        assert private_value not in caplog.text


@pytest.mark.parametrize("stage", ["prepare", "decode"])
def test_stage_failure_preserves_error_and_logs_only_completed_measurements(
    monkeypatch, tmp_path, caplog, stage
):
    clock = [0.0]
    monkeypatch.setattr(backend_module, "perf_counter", lambda: clock[0], raising=False)
    failure = ValueError("PRIVATE_ERROR")

    def transcribe(_path, **_kwargs):
        clock[0] += 0.017
        if stage == "prepare":
            raise failure

        def segments():
            yield SimpleNamespace(text="PRIVATE_PARTIAL")
            clock[0] += 0.023
            raise failure

        return segments(), SimpleNamespace(duration=1.2, duration_after_vad=0.35)

    backend = make_backend(monkeypatch, tmp_path, transcribe)
    with caplog.at_level(logging.INFO, logger="openclaw_local_stt.app"):
        with pytest.raises(ValueError) as raised:
            backend.transcribe(tmp_path / "PRIVATE_AUDIO.wav", language=None, prompt=None)
    assert raised.value is failure
    assert diagnostic_records(caplog) == [{
        "event": "local_media_stt_backend",
        "outcome": "failed",
        "vadEnabled": True,
        "durationMs": None if stage == "prepare" else 1200,
        "durationAfterVadMs": None if stage == "prepare" else 350,
        "segmentCount": 0 if stage == "prepare" else 1,
        "prepareMs": 17,
        "decodeMs": None if stage == "prepare" else 23,
        "totalMs": 17 if stage == "prepare" else 40,
    }]
    assert "PRIVATE_" not in caplog.text


def test_invalid_duration_metadata_is_not_serialized_as_nonfinite_json(
    monkeypatch, tmp_path, caplog
):
    backend = make_backend(
        monkeypatch, tmp_path,
        lambda *_args, **_kwargs: (
            iter([]), SimpleNamespace(duration=float("nan"), duration_after_vad=float("inf"))
        ),
    )
    with caplog.at_level(logging.INFO, logger="openclaw_local_stt.app"):
        assert backend.transcribe(tmp_path / "input.wav", language=None, prompt=None) == ""
    records = diagnostic_records(caplog)
    assert len(records) == 1
    assert records[0]["durationMs"] is None
    assert records[0]["durationAfterVadMs"] is None


def test_logger_failure_does_not_change_transcription(monkeypatch, tmp_path):
    backend = make_backend(
        monkeypatch, tmp_path,
        lambda *_args, **_kwargs: (
            iter([SimpleNamespace(text="result")]),
            SimpleNamespace(duration=1.2, duration_after_vad=0.35),
        ),
    )
    logged = []

    def broken_logger(message):
        logged.append(message)
        raise RuntimeError("Logger unavailable")

    monkeypatch.setattr(logging.getLogger("openclaw_local_stt.app"), "info", broken_logger)
    assert backend.transcribe(tmp_path / "input.wav", language=None, prompt=None) == "result"
    assert len(logged) == 1


@pytest.mark.parametrize(
    ("vad_enabled", "retained", "confirmed"),
    [(True, 0.35, True), (True, 0.0, False), (True, float("nan"), False),
     (True, float("inf"), False), (False, 0.35, False)],
)
def test_stream_confirms_only_retained_vad_audio_before_lazy_decode(
    monkeypatch, tmp_path, vad_enabled, retained, confirmed
):
    actions = []

    def transcribe(_path, **kwargs):
        actions.append("prepared")
        assert kwargs["vad_filter"] is vad_enabled

        def segments():
            actions.append("decoded")
            yield SimpleNamespace(text="result")

        return segments(), SimpleNamespace(duration=1.2, duration_after_vad=retained)

    backend = make_backend(monkeypatch, tmp_path, transcribe)
    backend.vad_filter = vad_enabled
    events = backend.transcribe_stream(tmp_path / "input.wav", language=None, prompt=None)
    if confirmed:
        assert next(events) == {"type": "speech.confirmed"}
        assert actions == ["prepared"]
    expected_speech_ms = (
        round(retained * 1000)
        if vad_enabled and isinstance(retained, (int, float)) and math.isfinite(retained)
        else None
    )
    assert next(events) == {
        "type": "transcript.done", "text": "result", "model": "PRIVATE_MODEL",
        "recognition": {
            "audioDurationMs": 1200,
            "speechDurationMs": expected_speech_ms,
            "segmentCount": 1,
            "signals": [],
        },
    }
    assert list(events) == []
    assert actions == ["prepared", "decoded"]


def test_stream_reports_bounded_backend_scoped_observations(monkeypatch, tmp_path):
    segments = iter([
        SimpleNamespace(
            text="first", avg_logprob=-0.5, no_speech_prob=0.2,
            compression_ratio=1.5,
        ),
        SimpleNamespace(
            text="second", avg_logprob=-0.3, no_speech_prob=float("nan"),
            compression_ratio=1000,
        ),
    ])
    backend = make_backend(
        monkeypatch, tmp_path,
        lambda *_args, **_kwargs: (
            segments, SimpleNamespace(duration=2.0, duration_after_vad=1.5)
        ),
    )
    events = list(backend.transcribe_stream(tmp_path / "input.wav", language=None, prompt=None))
    assert events[-1]["recognition"] == {
        "audioDurationMs": 2000,
        "speechDurationMs": 1500,
        "segmentCount": 2,
        "signals": [
            {"name": "fasterWhisper.avgLogProbability", "mean": -0.4, "samples": 2},
            {"name": "fasterWhisper.compressionRatio", "mean": 1.5, "samples": 1},
            {"name": "fasterWhisper.noSpeechProbability", "mean": 0.2, "samples": 1},
        ],
    }


def test_closing_after_confirmation_closes_decoder_without_starting_it(
    monkeypatch, tmp_path, caplog
):
    actions = []

    class Segments:
        def __iter__(self):
            return self

        def __next__(self):
            actions.append("decoded")
            return SimpleNamespace(text="must not decode")

        def close(self):
            actions.append("closed")

    backend = make_backend(
        monkeypatch, tmp_path,
        lambda *_args, **_kwargs: (
            Segments(), SimpleNamespace(duration=1.2, duration_after_vad=0.35)
        ),
    )
    with caplog.at_level(logging.INFO, logger="openclaw_local_stt.app"):
        events = backend.transcribe_stream(tmp_path / "input.wav", language=None, prompt=None)
        assert next(events) == {"type": "speech.confirmed"}
        events.close()
    assert actions == ["closed"]
    assert diagnostic_records(caplog)[0]["outcome"] == "cancelled"
    assert diagnostic_records(caplog)[0]["decodeMs"] is None


def test_cancel_after_confirmation_skips_lazy_decoder(monkeypatch, tmp_path):
    decoded = []
    def segments():
        decoded.append(True)
        yield SimpleNamespace(text="not allowed")
    backend = make_backend(monkeypatch, tmp_path, lambda *a, **kw: (
        segments(), SimpleNamespace(duration=1, duration_after_vad=1),
    ))
    cancelled = [False]
    def checkpoint():
        if cancelled[0]:
            raise RuntimeError("cancelled")
    stream = backend.transcribe_stream(tmp_path / "input.wav", language=None, prompt=None, checkpoint=checkpoint)
    assert next(stream) == {"type": "speech.confirmed"}
    cancelled[0] = True
    with pytest.raises(RuntimeError, match="cancelled"):
        next(stream)
    assert decoded == []
