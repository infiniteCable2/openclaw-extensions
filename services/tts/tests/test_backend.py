from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

import numpy as np
import pytest

from openclaw_local_tts.backend import ChatterboxBackend


def test_reference_voice_changes_per_request_without_model_reload(tmp_path, monkeypatch) -> None:
    model_path = tmp_path / "model"
    chatterbox_source = tmp_path / "chatterbox-source"
    perth_source = tmp_path / "perth-source"
    s3tokenizer_source = tmp_path / "s3tokenizer-source"
    for path in (model_path, chatterbox_source, perth_source, s3tokenizer_source):
        path.mkdir()
    astrid = tmp_path / "astrid.wav"
    nova = tmp_path / "nova.wav"
    astrid.write_bytes(b"astrid")
    nova.write_bytes(b"nova")

    generated_references: list[tuple[str, dict[str, object]]] = []
    load_calls: list[tuple[str, dict[str, object]]] = []

    class FakeClient:
        device = "cuda:0"
        sr = 24_000

        def generate(self, *, text, language_id, audio_prompt_path, **generation):
            assert text
            assert language_id == "de"
            generated_references.append((audio_prompt_path, generation))
            return np.array([[0.0, 0.5, -0.5]], dtype=np.float32)

    class FakeChatterbox:
        @classmethod
        def from_local(cls, model, device=None, t3_model=None):
            load_calls.append((model, {"device": device, "t3_model": t3_model}))
            return FakeClient()

    torch_module = ModuleType("torch")
    torch_module.cuda = SimpleNamespace(is_available=lambda: True)
    torch_module.Tensor = type("Tensor", (), {})
    chatterbox_module = ModuleType("chatterbox")
    chatterbox_module.__path__ = []
    mtl_module = ModuleType("chatterbox.mtl_tts")
    mtl_module.ChatterboxMultilingualTTS = FakeChatterbox
    monkeypatch.setitem(sys.modules, "torch", torch_module)
    monkeypatch.setitem(sys.modules, "chatterbox", chatterbox_module)
    monkeypatch.setitem(sys.modules, "chatterbox.mtl_tts", mtl_module)

    backend = ChatterboxBackend(
        model_path=model_path,
        voice_references={"astrid": astrid, "nova": nova},
        default_voice="astrid",
        chatterbox_source=chatterbox_source,
        perth_source=perth_source,
        s3tokenizer_source=s3tokenizer_source,
        voice_generation_settings={"nova": {"temperature": 0.7}},
    )
    first = backend.synthesize("Hallo", voice_id="astrid")
    second = backend.synthesize("Guten Tag", voice_id="nova")

    assert len(load_calls) == 1
    assert load_calls[0][1] == {"device": "cuda", "t3_model": "v3"}
    assert generated_references == [
        (str(astrid.resolve()), {}),
        (str(nova.resolve()), {"temperature": 0.7}),
    ]
    assert first.sample_rate == second.sample_rate == 24_000
    assert len(first.data) == len(second.data) == 6


def test_default_voice_must_be_allowlisted(tmp_path) -> None:
    model_path = tmp_path / "model"
    chatterbox_source = tmp_path / "chatterbox-source"
    perth_source = tmp_path / "perth-source"
    s3tokenizer_source = tmp_path / "s3tokenizer-source"
    for path in (model_path, chatterbox_source, perth_source, s3tokenizer_source):
        path.mkdir()
    reference = tmp_path / "voice.wav"
    reference.write_bytes(b"voice")

    with pytest.raises(ValueError, match="default_voice"):
        ChatterboxBackend(
            model_path=model_path,
            voice_references={"astrid": reference},
            default_voice="missing",
            chatterbox_source=chatterbox_source,
            perth_source=perth_source,
            s3tokenizer_source=s3tokenizer_source,
        )
