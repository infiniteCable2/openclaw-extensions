import math

import numpy as np
import pytest

from openclaw_local_stt.speech_apm import (
    FRAME_SAMPLES, SAMPLE_RATE, SpeechControlConfig, create_speech_processor,
)


def signal(seconds=2):
    t = np.arange(int(SAMPLE_RATE * seconds), dtype=np.float32) / SAMPLE_RATE
    rng = np.random.default_rng(17)
    voice = sum(np.sin(2 * np.pi * 135 * harmonic * t) / harmonic for harmonic in range(1, 8))
    return np.asarray(0.02 * voice * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t)) +
                      0.001 * rng.standard_normal(t.size), dtype=np.float32)


def process_chunks(audio, size):
    processor = create_speech_processor()
    return np.concatenate([processor.process(audio[i:i + size]) for i in range(0, len(audio), size)])


def test_live_and_file_chunks_use_the_identical_native_control_clock():
    audio = signal()
    expected = process_chunks(audio, FRAME_SAMPLES)
    np.testing.assert_array_equal(process_chunks(audio, FRAME_SAMPLES * 2), expected)
    np.testing.assert_array_equal(process_chunks(audio, SAMPLE_RATE), expected)


def test_cold_start_never_exceeds_configured_gain_ceiling():
    processor = create_speech_processor()
    audio = signal(0.1)
    for i in range(0, len(audio), FRAME_SAMPLES * 2):
        result = processor.process(audio[i:i + FRAME_SAMPLES * 2])
        assert processor.gain_db <= 12.01
        assert result.size == FRAME_SAMPLES * 2
        assert np.isfinite(result).all()


def test_silence_does_not_claim_speech_or_erase_previous_filter_state():
    processor = create_speech_processor()
    processor.process(signal())
    for _ in range(100):
        result = processor.process(np.zeros(FRAME_SAMPLES * 2, dtype=np.float32))
        assert processor.speech_probability == 0
        assert math.isfinite(processor.gain_db)
        assert np.isfinite(result).all()
    assert np.max(np.abs(result)) < 1e-5


def test_level_steps_and_overload_remain_finite_and_limited():
    processor = create_speech_processor()
    voice = signal(0.2)
    for factor in (0.01, 1, 40, 0.1, 1):
        audio = np.clip(voice * factor, -1, 1).astype(np.float32)
        result = processor.process(audio)
        assert np.max(np.abs(result)) <= 1.001
        assert np.isfinite(result).all()
        assert 0 <= processor.speech_probability <= 1


def test_partial_final_frame_is_not_lost_or_exposed_as_padding():
    audio = signal(0.11)[:FRAME_SAMPLES + 7]
    result = create_speech_processor().process(audio)
    expected = create_speech_processor().process(np.pad(audio, (0, FRAME_SAMPLES - 7)))
    assert result.shape == audio.shape
    np.testing.assert_array_equal(result, expected[:len(audio)])


@pytest.mark.parametrize("audio", [
    np.array([np.nan], dtype=np.float32),
    np.array([np.inf], dtype=np.float32),
    np.zeros((2, 160), dtype=np.float32),
    np.zeros(160, dtype=np.float64),
])
def test_invalid_pcm_fails_before_native_processing(audio):
    with pytest.raises(ValueError, match="mono float32"):
        create_speech_processor().process(audio)


def test_explicit_native_probability_and_one_gain_owner(monkeypatch):
    import pywebrtc_audio

    calls = []

    class Cleaner:
        def __init__(self, **settings):
            assert settings["auto_gain_control"] is False
            self.speech_probability = 0.0

        def process(self, frame):
            self.speech_probability = 0.9 if frame[0] else 0.2
            return frame * np.float32(0.5)

    class Gain:
        def __init__(self, **settings):
            assert settings["fixed_gain_db"] == 0
            assert settings["max_output_noise_level_dbfs"] == -50
            assert settings["max_gain_change_db_per_second"] == 6

        def process(self, frame, *, speech_probability):
            calls.append(speech_probability)
            return frame * np.float32(2 if speech_probability else 1)

    monkeypatch.setattr(pywebrtc_audio, "AudioProcessor", Cleaner)
    monkeypatch.setattr(pywebrtc_audio, "GainController", Gain)
    processor = create_speech_processor()
    assert len(calls) == 51 and set(calls) == {0.0}
    calls.clear()
    audio = np.concatenate((np.full(160, 0.1, dtype=np.float32), np.zeros(160, dtype=np.float32)))
    result = processor.process(audio)
    assert calls == [0.9, 0.0]
    assert processor.speech_probability == 0.0
    assert processor.gain_db == pytest.approx(20 * math.log10(2))
    assert processor.control == pytest.approx({
        "cleanRms": math.sqrt(0.05 ** 2 / 2),
        "nativeGainDb": 20 * math.log10(2),
        "minimumCeilingDb": -18 - 20 * math.log10(0.05),
        "maximumCeilingDb": -18 - 20 * math.log10(0.05),
        "speechFrames": 1, "uncertainFrames": 0, "nonspeechFrames": 1,
        "holdFrames": 1, "attenuateFrames": 1, "recoverFrames": 0,
        "clippedFrames": 0, "mutedFrames": 1,
    })
    np.testing.assert_array_equal(result, audio)


def test_control_settings_are_bounded():
    for settings in ({"max_gain_db": 20}, {"headroom_db": float("nan")},
                     {"max_gain_change_db_per_second": 0}, {"speech_ceiling_dbfs": 0},
                     {"max_attenuation_db": 30}, {"attenuation_db_per_second": float("nan")},
                     {"recovery_db_per_second": 0}):
        with pytest.raises(ValueError):
            SpeechControlConfig(**settings)
