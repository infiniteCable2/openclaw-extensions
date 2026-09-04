from __future__ import annotations

import json

import pytest

from openclaw_local_tts.voice_catalog import load_voice_catalog


def _write_catalog(tmp_path, *, voices=None, default_voice="astrid"):
    first = tmp_path / "astrid.wav"
    second = tmp_path / "nova.wav"
    first.write_bytes(b"astrid")
    second.write_bytes(b"nova")
    catalog_path = tmp_path / "voices.json"
    catalog_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "default_voice": default_voice,
                "voices": voices
                or [
                    {
                        "id": "astrid",
                        "name": "Astrid",
                        "reference_path": str(first),
                        "locale": "de-DE",
                        "description": "Ruhige Standardstimme",
                        "generation": {
                            "exaggeration": 0.5,
                            "temperature": 0.8,
                            "cfg_weight": 0.5,
                        },
                    },
                    {
                        "id": "nova",
                        "name": "Nova",
                        "reference_path": str(second),
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    return catalog_path, first, second


def test_catalog_keeps_private_paths_separate_from_public_metadata(tmp_path) -> None:
    catalog_path, first, second = _write_catalog(tmp_path)

    catalog = load_voice_catalog(catalog_path)

    assert catalog.default_voice == "astrid"
    assert catalog.references == {"astrid": first.resolve(), "nova": second.resolve()}
    assert catalog.generation_settings["astrid"] == {
        "exaggeration": 0.5,
        "temperature": 0.8,
        "cfg_weight": 0.5,
    }
    assert catalog.public_voices == (
        {
            "id": "astrid",
            "name": "Astrid",
            "locale": "de-DE",
            "description": "Ruhige Standardstimme",
        },
        {"id": "nova", "name": "Nova"},
    )


@pytest.mark.parametrize(
    "generation",
    [
        {"unknown": 1},
        {"temperature": 0},
        {"temperature": float("inf")},
        {"cfg_weight": True},
    ],
)
def test_catalog_rejects_unsafe_generation_settings(tmp_path, generation) -> None:
    reference = tmp_path / "voice.wav"
    reference.write_bytes(b"voice")
    catalog_path, _first, _second = _write_catalog(
        tmp_path,
        voices=[
            {
                "id": "astrid",
                "name": "Astrid",
                "reference_path": str(reference),
                "generation": generation,
            }
        ],
    )

    with pytest.raises(ValueError, match="generation"):
        load_voice_catalog(catalog_path)


def test_catalog_rejects_a_symlinked_reference(tmp_path) -> None:
    reference = tmp_path / "voice.wav"
    reference.write_bytes(b"voice")
    link = tmp_path / "linked.wav"
    try:
        link.symlink_to(reference)
    except OSError:
        pytest.skip("symlinks unavailable in this test environment")
    catalog_path, _first, _second = _write_catalog(
        tmp_path,
        voices=[
            {"id": "astrid", "name": "Astrid", "reference_path": str(link)}
        ],
    )

    with pytest.raises(ValueError, match="non-symlink"):
        load_voice_catalog(catalog_path)
