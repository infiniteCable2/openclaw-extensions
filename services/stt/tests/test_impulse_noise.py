import numpy as np

from openclaw_local_stt.impulse_noise import is_isolated_impulse


def burst():
    audio = np.zeros(16_000, dtype=np.float32)
    audio[3200] = 0.85
    return audio


def test_isolated_impulse_requires_observed_silence_and_broadband_evidence():
    audio = burst()
    assert is_isolated_impulse(audio)
    assert not is_isolated_impulse(audio[:3500])
    tonal = np.zeros_like(audio)
    tonal[3200:3520] = 0.5 * np.sin(np.arange(320) * np.pi / 16)
    assert not is_isolated_impulse(tonal)


def test_impulse_followed_by_quiet_speech_like_energy_reaches_recognizer():
    audio = burst()
    audio[3680:5600] = 0.01 * np.sin(np.arange(1920) * np.pi / 40)
    assert not is_isolated_impulse(audio)
