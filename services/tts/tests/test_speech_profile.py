from __future__ import annotations

import json

import pytest

from openclaw_local_tts.speech_profile import (
    CHATTERBOX_SPEECH_PROFILE, KITTEN_SPEECH_PROFILE, SpeechProfile, load_speech_profile,
)
from openclaw_local_tts.speech_segments import split_speech_text, validate_prepared_segments


def test_chatterbox_profile_preserves_existing_segments_and_pauses():
    text = "Der erste Satz bleibt erhalten.\n\nDer zweite Satz bleibt erhalten."
    old = split_speech_text(text)
    assert old == split_speech_text(text, profile=CHATTERBOX_SPEECH_PROFILE)
    assert [unit.pause_after_ms for unit in old] == [320, 180]
    assert CHATTERBOX_SPEECH_PROFILE.public() == {
        "minChars": 0, "targetWords": 32, "maxWords": 45, "maxChars": 400,
        "pauses": {"paragraph": 320, "sentence": 180, "clause": 80, "fragment": 60},
    }


def test_kitten_packs_short_paragraphs_without_changing_source_words():
    text = "\n\n".join("Dies ist ein kurzer Absatz mit sinnvoll verständlichem Inhalt." for _ in range(5))
    units = split_speech_text(text, profile=KITTEN_SPEECH_PROFILE)
    assert len(units) < len(split_speech_text(text))
    assert " ".join(unit.text for unit in units).split() == text.split()
    assert all(len(unit.text) <= KITTEN_SPEECH_PROFILE.max_chars for unit in units)
    assert all(len(unit.text) >= 130 for unit in units)


def test_short_completed_utterance_is_not_padded_or_discarded():
    units = split_speech_text("Hallo.", profile=KITTEN_SPEECH_PROFILE)
    assert [unit.text for unit in units] == ["Hallo."]


def test_kitten_keeps_the_established_join_pause_settings():
    assert KITTEN_SPEECH_PROFILE.public()["pauses"] == CHATTERBOX_SPEECH_PROFILE.public()["pauses"]


@pytest.mark.parametrize("field,value", [("minChars", True), ("minChars", -1),
    ("maxChars", 63), ("maxWords", 201), ("targetWords", 46)])
def test_profile_rejects_invalid_limits(field, value):
    profile = CHATTERBOX_SPEECH_PROFILE.public()
    profile[field] = value
    with pytest.raises(ValueError):
        SpeechProfile.parse(profile)


def test_explicit_profile_file_is_admitted_once(tmp_path):
    path = tmp_path / "profile.json"
    path.write_text(json.dumps(KITTEN_SPEECH_PROFILE.public()), encoding="utf-8")
    assert load_speech_profile(path) == KITTEN_SPEECH_PROFILE


def prepared(*units):
    return {"schema_version": 1, "segments": [{"text": text, "pauseMs": 180} for text in units]}


def test_prepared_plan_preserves_exact_content_and_never_rechunks():
    source = "Erster Satz.\n\nZweiter Satz."
    units = validate_prepared_segments(source, prepared("Erster Satz.", "Zweiter Satz."), CHATTERBOX_SPEECH_PROFILE)
    assert [unit.text for unit in units] == ["Erster Satz.", "Zweiter Satz."]
    assert len(split_speech_text(source.replace("\n\n", " "))) == 1


@pytest.mark.parametrize("source,plan", [
    ("Hallo Welt.", prepared("Hallo")),
    ("Hallo Welt.", prepared("Welt.", "Hallo")),
    ("Hallo Welt.", prepared("Hallo Andere.")),
    ("Hallo.", prepared("Hallo.", "Hallo.")),
    ("Hallo.", prepared("Hal", "lo.")),
    ("Hallo.", {"schema_version": True, "segments": [{"text": "Hallo.", "pauseMs": 0}]}),
    ("Hallo.", {"schema_version": 1, "segments": [{"text": "Hallo.", "pauseMs": True}]}),
    ("Hallo.", {"schema_version": 1, "segments": [{"text": "Hallo.", "pauseMs": 1999}]}),
])
def test_invalid_prepared_plan_fails_instead_of_repairing(source, plan):
    with pytest.raises(ValueError):
        validate_prepared_segments(source, plan, CHATTERBOX_SPEECH_PROFILE)
