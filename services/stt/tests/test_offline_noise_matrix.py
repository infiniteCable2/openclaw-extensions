from __future__ import annotations

import math
import wave

import numpy as np
import pytest

from tools.offline_noise_matrix import (
    PROFILES,
    evaluate,
    noise,
    parse_levels,
    read_voice,
    rms,
    word_error_rate,
)


def test_noise_profiles_are_repeatable_and_normalized() -> None:
    for profile in PROFILES:
        first = noise(profile, 16_000)
        assert np.array_equal(first, noise(profile, 16_000))
        assert math.isclose(rms(first), 1.0, rel_tol=0.001)
    assert not np.array_equal(noise("road", 16_000), noise("wash", 16_000))


def test_rejects_invalid_voice_or_level_matrix(tmp_path) -> None:
    wav = tmp_path / "silent.wav"
    with wave.open(str(wav), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16_000)
        target.writeframes(b"\0\0" * 16_000)
    with pytest.raises(ValueError, match="nonzero"):
        read_voice(wav)
    with pytest.raises(ValueError, match="level matrix"):
        parse_levels("-100", minimum=-60, maximum=-3)


def test_offline_apm_and_vad_report_metrics_without_decoder() -> None:
    time = np.arange(16_000, dtype=np.float32) / 16_000
    voice_like = np.sin(2 * np.pi * 220 * time).astype(np.float32) * 0.02
    result = evaluate(voice_like)
    assert 0 <= result["speechProbabilityMean"] <= 1
    assert 0 <= result["speechProbabilityPeak"] <= 1
    assert 0 <= result["vadSpeechMs"] <= 1_000
    assert result["wer"] is None


def test_word_error_rate_has_no_transcript_output() -> None:
    assert word_error_rate("Guten Morgen zusammen", "guten Morgen zusammen") == 0
    assert word_error_rate("Guten Morgen zusammen", "Guten zusammen") == pytest.approx(1 / 3)
