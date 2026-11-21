"""Conservative CPU veto for isolated broadband impulses in live speech audio."""

from __future__ import annotations

from .audio_decode import SAMPLE_RATE


_FRAME = SAMPLE_RATE // 50
_MAX_FRAMES_WITH_SIGNAL = 4
_QUIET_TAIL_FRAMES = 4
_MAX_SAMPLES = SAMPLE_RATE * 4


def is_isolated_impulse(audio) -> bool:
    """Return true only for a short, loud, broadband event surrounded by quiet."""
    import numpy as np

    if audio.ndim != 1 or not 0 < audio.size <= _MAX_SAMPLES:
        return False

    peak = float(np.max(np.abs(audio)))
    if peak < 0.18 or not np.isfinite(peak):
        return False

    padded = np.pad(audio, (0, -audio.size % _FRAME))
    frames = padded.reshape(-1, _FRAME)
    rms = np.sqrt(np.mean(np.square(frames), axis=1))
    # Keep a low floor so quiet words after a loud transient veto the rejection.
    active = np.flatnonzero(rms >= 0.001)
    if not active.size or active[-1] - active[0] + 1 > _MAX_FRAMES_WITH_SIGNAL:
        return False

    # A partial/padded trailing frame does not count as observed quiet.
    if audio.size // _FRAME - int(active[-1]) - 1 < _QUIET_TAIL_FRAMES:
        return False

    peak_sample = int(np.argmax(np.abs(audio)))
    radius = SAMPLE_RATE // 100
    start = max(0, peak_sample - radius)
    stop = min(audio.size, peak_sample + radius + 1)
    window = audio[start:stop]
    if window.size < radius:
        return False

    power = np.abs(np.fft.rfft(window * np.hanning(window.size))) ** 2
    # Spectral flatness supplies evidence independent of the Silero speech score.
    band = power[2:-2] + 1e-12
    return bool(np.exp(np.mean(np.log(band))) / np.mean(band) >= 0.45)
