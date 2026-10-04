import numpy as np
import pytest

from openclaw_local_stt.speech_gain import SpeechGainSupervisor


def control():
    return SpeechGainSupervisor(max_gain_db=12, max_attenuation_db=12,
                                speech_ceiling_dbfs=-18, attenuation_db_per_second=24,
                                recovery_db_per_second=6)


def frame(level):
    return np.full(160, level, dtype=np.float32)


def step(owner, level, probability, native_gain=0):
    clean = frame(level)
    permission = owner.observe(clean, clean, probability)
    native = clean * np.float32(10 ** (native_gain / 20))
    output = owner.select(clean, native)
    return output, permission


def test_loud_speech_is_attenuated_below_unity_without_using_a_limiter():
    owner = control()
    for _ in range(100):
        output, permission = step(owner, 0.4, 0.99)
    assert permission == 0.99
    assert owner.state == "speech"
    assert 20 * np.log10(np.sqrt(np.mean(output ** 2))) == pytest.approx(-18, abs=0.01)
    assert np.max(output) < 0.4


def test_native_quiet_speech_boost_is_preserved_not_multiplied():
    owner = control()
    for _ in range(100):
        output, _ = step(owner, 0.01, 0.99, native_gain=12)
        np.testing.assert_allclose(output, frame(0.01 * 10 ** (12 / 20)), rtol=1e-6)


def test_brief_uncertainty_freezes_learning_and_attenuation():
    owner = control()
    for _ in range(100):
        output, _ = step(owner, 0.4, 0.99)
    held = float(output[-1] / 0.4)
    for level, probability in ((0.02, 0.5), (0.4, 0.5), (0.002, 0.1)):
        for _ in range(25):
            output, permission = step(owner, level, probability)
            assert permission == 0
            assert output[-1] / level == pytest.approx(held, rel=1e-5)
            assert np.any(output)  # No audio erasure or speech gate here.


def test_prolonged_uncertainty_releases_negative_gain_only_toward_unity():
    owner = control()
    for _ in range(100):
        step(owner, 0.4, 0.99)
    for _ in range(400):
        output, permission = step(owner, 0.01, 0.5)
        assert permission == 0
        assert output[-1] <= 0.010001
    assert output[-1] == pytest.approx(0.01, abs=1e-6)
    # A later native proposal cannot turn recovery into permission to boost.
    for _ in range(100):
        output, _ = step(owner, 0.01, 0.5, native_gain=6)
        assert output[-1] <= 0.010001


def test_recovery_requires_speech_and_is_slew_bounded():
    owner = control()
    for _ in range(100):
        previous, _ = step(owner, 0.4, 0.99)
    previous_gain = 20 * np.log10(previous[-1] / 0.4)
    for _ in range(700):
        output, _ = step(owner, 0.01, 0.99)
        gain = 20 * np.log10(output[-1] / 0.01)
        assert gain - previous_gain <= 0.0601
        previous_gain = gain
    assert gain == pytest.approx(0, abs=0.01)


def test_original_clipping_is_not_permission_to_increase_gain():
    owner = control()
    assert owner.observe(frame(1), frame(0.4), 0.99) == 0
    assert owner.state == "uncertain"
    assert owner.observe(frame(0), frame(0.01), 0.99) == 0
    assert owner.state == "nonspeech"


def test_untrusted_loud_noise_cannot_train_the_speech_level():
    owner = control()
    for _ in range(300):
        step(owner, 0.7, 0.5)
    output, _ = step(owner, 0.01, 0.99, native_gain=12)
    assert output[-1] == pytest.approx(0.01 * 10 ** (12 / 20), rel=1e-5)


def test_instances_are_isolated_and_native_limiting_is_never_undone():
    owner = control()
    for _ in range(100):
        step(owner, 0.4, 0.99)
    fresh = control()
    output, _ = step(fresh, 0.01, 0.99, native_gain=6)
    assert output[-1] == pytest.approx(0.01 * 10 ** (6 / 20), rel=1e-5)
    for probability in (0.1, 0.5, 0.99):
        for native_gain in (-20, -3, 0, 12):
            output, _ = step(owner, 0.2, probability, native_gain=native_gain)
            assert np.max(np.abs(output)) <= 0.2 * 10 ** (native_gain / 20) * 1.00001


def test_maximum_attenuation_is_bounded_without_suppressing_audio():
    owner = control()
    for _ in range(500):
        output, _ = step(owner, 0.9, 0.99)
    assert 20 * np.log10(output[-1] / 0.9) == pytest.approx(-12, abs=0.01)


def test_native_gain_drop_cannot_compound_a_held_negative_ceiling():
    owner = control()
    for _ in range(300):
        step(owner, 0.4, 0.99, native_gain=6)
    for native_gain in (0, -6, -20):
        output, _ = step(owner, 0.01, 0.5, native_gain=native_gain)
        measured = 20 * np.log10(output[-1] / 0.01)
        assert measured >= min(-12, native_gain) - 0.001
        assert np.max(output) <= 0.01 * 10 ** (native_gain / 20) * 1.00001


def test_ceiling_diagnostics_distinguish_attenuation_hold_and_recovery():
    owner = control()
    step(owner, 0.4, 0.99)
    assert owner.ceiling_action == "attenuate"
    assert owner.ceiling_db < 0
    previous = owner.ceiling_db
    step(owner, 0.01, 0.5)
    assert owner.ceiling_action == "hold"
    assert owner.ceiling_db == previous
    for _ in range(99):
        step(owner, 0.01, 0.5)
    assert owner.ceiling_action == "recover"
    assert previous < owner.ceiling_db <= 0
