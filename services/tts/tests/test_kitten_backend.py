from __future__ import annotations

import json
import sys
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest

from openclaw_local_tts.kitten_backend import KittenTts2Backend
from openclaw_local_tts.voice_catalog import VoiceCatalog, VoiceDefinition


@pytest.fixture
def setup_backend(tmp_path, monkeypatch):
    model = tmp_path / "model"
    model.mkdir()
    (model / "config.json").write_text(json.dumps({"type": "KITTEN2"}))
    cache = model / "offline-cache"
    cache.mkdir()
    voices = []
    for name in ("voice_a", "voice_b"):
        reference = tmp_path / f"{name}.wav"
        reference.write_bytes(b"synthetic reference")
        voices.append(VoiceDefinition(name, name, reference, reference_text=f"Referenz {name}"))
    catalog = VoiceCatalog("voice_a", tuple(voices))
    calls = []
    loads = []
    def cuda_module():
        return SimpleNamespace(
            parameters=lambda: iter([SimpleNamespace(device="cuda:0")]),
            buffers=lambda: iter([SimpleNamespace(device="cuda:0")]),
        )

    client = SimpleNamespace(
        device="cuda:0", backend="torch", sample_rate=24_000,
        model=cuda_module(), codec=SimpleNamespace(s3gen=cuda_module(), student=None),
        speaker_encoder=SimpleNamespace(_model=cuda_module()),
        transcriber=SimpleNamespace(_pipeline=None),
    )

    def generate(text, **kwargs):
        calls.append((text, kwargs))
        return np.array([0.0, 0.25, -0.25], dtype=np.float32)

    def load(path, **kwargs):
        loads.append((path, kwargs))
        return client

    client.generate = generate
    torch = ModuleType("torch")
    torch.cuda = SimpleNamespace(is_available=lambda: True)
    kitten = ModuleType("kittenml")
    kitten.KittenTTS = load
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "kittenml", kitten)
    # Construction intentionally changes offline settings for its worker process.
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setenv("TRANSFORMERS_OFFLINE", "1")
    return model, catalog, client, calls, loads


def test_cuda_clone_switching_and_all_voices_warmed_before_ready(setup_backend):
    model, catalog, _client, calls, loads = setup_backend
    backend = KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)
    assert len(loads) == 1
    assert loads[0][1] == {
        "device": "cuda", "weights": "packed", "backend": "torch", "decoder": "default",
        "cache_dir": str(model / "offline-cache"),
    }
    assert [call[1]["reference_text"] for call in calls] == ["Referenz voice_a", "Referenz voice_b"]
    assert all(call[1]["normalize"] is False for call in calls)
    calls.clear()
    pcm = list(backend.synthesize_segments(["Hallo.", "Guten Tag."], voice_id="voice_b"))
    assert all(len(segment.data) == 6 and segment.sample_rate == 24_000 for segment in pcm)
    assert len(loads) == 1
    assert all(call[1]["reference_text"] == "Referenz voice_b" for call in calls)
    assert all(call[1]["advanced"]["use_emotion"] is False for call in calls)
    assert all(call[1]["advanced"]["chunk_chars"] == 0 for call in calls)
    list(backend.synthesize_expressive_segments(["[joyful] Hallo <laugh> Welt."], voice_id="voice_a"))
    assert calls[-1][1]["advanced"]["use_emotion"] is True


def test_no_implicit_reference_transcription(setup_backend):
    model, catalog, _client, _calls, loads = setup_backend
    voice = catalog.voices[0]
    without_text = VoiceCatalog(voice.id, (VoiceDefinition(voice.id, voice.name, voice.reference_path),))
    with pytest.raises(ValueError, match="reference_text"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=without_text)
    assert loads == []


def test_no_chatterbox_parameter_fallback(setup_backend):
    model, catalog, _client, _calls, loads = setup_backend
    voice = catalog.voices[0]
    configured = VoiceCatalog(voice.id, (VoiceDefinition(
        voice.id, voice.name, voice.reference_path, reference_text="Referenz",
        generation={"exaggeration": 0.5},
    ),))
    with pytest.raises(ValueError, match="generation settings"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=configured)
    assert loads == []


@pytest.mark.parametrize("device", ["cpu", "unknown"])
def test_observed_cpu_or_unknown_is_not_ready(setup_backend, device):
    model, catalog, client, calls, _loads = setup_backend
    client.device = device
    with pytest.raises(RuntimeError, match="CUDA backend"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)
    assert calls == []


def test_cuda_unavailable_never_loads_model(setup_backend):
    model, catalog, _client, _calls, loads = setup_backend
    sys.modules["torch"].cuda.is_available = lambda: False
    with pytest.raises(RuntimeError, match="CUDA is unavailable"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)
    assert loads == []


@pytest.mark.parametrize("waveform", [[], [float("nan")], [float("inf")], [[0.0, 0.5]]])
def test_invalid_audio_is_not_ready(setup_backend, waveform):
    model, catalog, client, _calls, _loads = setup_backend
    client.generate = lambda *_args, **_kwargs: waveform
    with pytest.raises(RuntimeError, match="invalid or oversized"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)


def test_plain_request_cannot_turn_on_expression(setup_backend):
    model, catalog, _client, calls, _loads = setup_backend
    backend = KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)
    calls.clear()
    with pytest.raises(ValueError, match="structured expression"):
        list(backend.synthesize_segments(["[joyful] Hallo."], voice_id="voice_a"))
    assert calls == []


@pytest.mark.parametrize("component", ["model", "codec", "speaker_encoder"])
@pytest.mark.parametrize("tensor_kind", ["parameters", "buffers"])
def test_every_gpu_component_is_verified(setup_backend, component, tensor_kind):
    model, catalog, client, _calls, _loads = setup_backend
    module = {
        "model": client.model,
        "codec": client.codec.s3gen,
        "speaker_encoder": client.speaker_encoder._model,
    }[component]
    setattr(module, tensor_kind, lambda: iter([SimpleNamespace(device="cpu")]))
    with pytest.raises(RuntimeError, match="non-CUDA tensors"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)


@pytest.mark.parametrize("component", ["codec", "speaker_encoder"])
def test_lazy_component_missing_is_not_ready(setup_backend, component):
    model, catalog, client, _calls, _loads = setup_backend
    if component == "codec":
        client.codec.s3gen = None
    else:
        client.speaker_encoder._model = None
    with pytest.raises(RuntimeError, match="was not loaded"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)


@pytest.mark.parametrize("component", ["decoder", "transcriber"])
def test_unrequested_model_is_not_ready(setup_backend, component):
    model, catalog, client, _calls, _loads = setup_backend
    if component == "decoder":
        client.codec.student = object()
    else:
        client.transcriber._pipeline = object()
    with pytest.raises(RuntimeError, match="unexpectedly loaded"):
        KittenTts2Backend(model_path=model, cache_dir=model / "offline-cache", catalog=catalog)


@pytest.mark.parametrize("path_kind", ["relative", "missing", "file"])
def test_explicit_private_offline_cache_required(setup_backend, path_kind):
    from pathlib import Path

    model, catalog, _client, _calls, loads = setup_backend
    cache = {"relative": Path("cache"), "missing": model / "absent", "file": model / "config.json"}[path_kind]
    with pytest.raises(ValueError, match="cache_dir"):
        KittenTts2Backend(model_path=model, cache_dir=cache, catalog=catalog)
    assert loads == []
