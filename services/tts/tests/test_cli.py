from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from openclaw_local_tts import cli, kitten_backend
from openclaw_local_tts.voice_catalog import VoiceCatalog, VoiceDefinition


@pytest.fixture
def cli_harness(monkeypatch, tmp_path):
    reference = tmp_path / "voice.wav"
    catalog = VoiceCatalog("voice_a", (
        VoiceDefinition("voice_a", "Example voice", reference, reference_text="Hallo Welt."),
    ))
    loads = []
    serves = []
    monkeypatch.setattr(cli, "load_voice_catalog", lambda _path: catalog)
    monkeypatch.setattr(cli, "ChatterboxBackend", lambda **kwargs: loads.append(("chatterbox", kwargs)) or object())
    monkeypatch.setattr(kitten_backend, "KittenTts2Backend", lambda **kwargs: loads.append(("kitten2", kwargs)) or object())
    monkeypatch.setattr(cli, "FfmpegAudioEncoder", lambda **_kwargs: object())
    monkeypatch.setattr(cli, "create_app", lambda *_args, **_kwargs: SimpleNamespace())
    monkeypatch.setattr(cli, "serve", lambda *_args, **kwargs: serves.append(kwargs))

    def run(extra):
        monkeypatch.setattr("sys.argv", [
            "openclaw-local-tts", "--model-path", str(tmp_path / "model"),
            "--voice-catalog", str(tmp_path / "catalog.json"), *extra,
        ])
        cli.main()

    return run, loads, serves


def test_cli_default_is_still_chatterbox(cli_harness):
    run, loads, serves = cli_harness
    run(["--chatterbox-source", "/example/source", "--perth-source", "/example/perth",
         "--s3tokenizer-source", "/example/tokenizer"])
    assert loads[0][0] == "chatterbox"
    assert loads[0][1]["model_id"] == "chatterbox"
    assert len(serves) == 1


def test_kitten_requires_explicit_offline_cache_before_loading(cli_harness):
    run, loads, serves = cli_harness
    with pytest.raises(SystemExit, match="offline codec cache"):
        run(["--backend", "kitten2"])
    assert loads == [] and serves == []


def test_kitten_passes_explicit_catalog_cache_and_weights(cli_harness):
    run, loads, serves = cli_harness
    run(["--backend", "kitten2", "--kitten-cache-dir", "/example/private-cache"])
    assert loads[0][0] == "kitten2"
    assert loads[0][1]["cache_dir"] == Path("/example/private-cache")
    assert loads[0][1]["weights"] == "packed"
    assert loads[0][1]["model_id"] == "kitten-tts-2"
    assert len(serves) == 1


@pytest.mark.parametrize("extra", [
    ["--kitten-cache-dir", "/example/cache"],
    ["--kitten-weights", "emb4"],
])
def test_chatterbox_rejects_kitten_only_arguments(cli_harness, extra):
    run, loads, serves = cli_harness
    with pytest.raises(SystemExit, match="cannot be applied"):
        run(extra)
    assert loads == [] and serves == []


def test_kitten_rejects_chatterbox_sources(cli_harness):
    run, loads, serves = cli_harness
    with pytest.raises(SystemExit, match="cannot be applied"):
        run(["--backend", "kitten2", "--kitten-cache-dir", "/example/cache",
             "--chatterbox-source", "/example/source"])
    assert loads == [] and serves == []
