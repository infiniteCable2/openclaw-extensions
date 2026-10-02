from __future__ import annotations

import math
import json
import sys
import wave

import numpy as np
import pytest

from tools.offline_noise_matrix import (
    PROFILES,
    evaluate,
    evaluate_raw,
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
    assert math.isfinite(result["gainDbMean"])
    assert math.isfinite(result["gainDbPeak"])
    assert 0 <= result["vadSpeechMs"] <= 1_000
    assert result["wer"] is None


def test_word_error_rate_has_no_transcript_output() -> None:
    assert word_error_rate("Guten Morgen zusammen", "guten Morgen zusammen") == 0
    assert word_error_rate("Guten Morgen zusammen", "Guten zusammen") == pytest.approx(1 / 3)


def test_paired_raw_control_does_not_invoke_apm(monkeypatch) -> None:
    from tools import offline_noise_matrix

    monkeypatch.setattr(
        offline_noise_matrix,
        "enhance",
        lambda _audio: (_ for _ in ()).throw(AssertionError("APM must not run")),
    )
    audio = np.zeros(16_000, dtype=np.float32)
    result = evaluate_raw(audio)
    assert result["rms"] == 0
    assert result["clipPercent"] == 0
    assert result["wer"] is None
    assert 0 <= result["vadSpeechMs"] <= 1_000


def test_direct_replay_reports_only_numeric_paired_results(tmp_path, monkeypatch, capsys) -> None:
    from tools import offline_noise_matrix

    wav = tmp_path / "private.wav"
    time = np.arange(16_000, dtype=np.float32) / 16_000
    signal = (np.sin(2 * np.pi * 220 * time) * 0.02 * 32767).astype("<i2")
    with wave.open(str(wav), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(16_000)
        target.writeframes(signal.tobytes())
    monkeypatch.setattr(sys, "argv", ["offline_noise_matrix.py", str(wav), "--direct"])
    offline_noise_matrix.main()
    output = capsys.readouterr().out
    result = json.loads(output)
    assert result["decoderTested"] is False
    assert result["cases"][0]["profile"] == "direct"
    assert result["cases"][0]["raw"]["wer"] is None
    assert result["cases"][0]["apm"]["wer"] is None
    assert "private" not in output
