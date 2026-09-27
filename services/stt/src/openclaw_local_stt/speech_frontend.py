"""WebRTC speech enhancement for audio explicitly addressed to the agent.

This is never applied to media relays or ordinary file analysis. Echo cancellation
requires a synchronized far-end render signal, which a transcription upload does
not have; capture-side AEC belongs at the originating device.
"""

from __future__ import annotations

import tempfile
import wave
from pathlib import Path


SAMPLE_RATE = 16_000
MAX_SAMPLES = SAMPLE_RATE * 15 * 60


def require_speech_frontend() -> None:
    """Fail startup if the configured speech pipeline cannot be provided."""
    import pywebrtc_audio  # noqa: F401


def enhance_speech_file(source: Path) -> Path:
    """Decode, enhance, and return a private temporary PCM WAV artifact."""
    import numpy as np
    from faster_whisper.audio import decode_audio
    from pywebrtc_audio import AudioProcessor

    audio = decode_audio(str(source), sampling_rate=SAMPLE_RATE)
    if audio.ndim != 1 or audio.size == 0 or audio.size > MAX_SAMPLES:
        raise ValueError("speech input duration is invalid")

    processor = AudioProcessor(
        sample_rate=SAMPLE_RATE,
        noise_suppression=True,
        high_pass_filter=True,
        auto_gain_control=True,
        echo_cancellation=False,
        ns_level=1,
        agc_max_gain_db=12.0,
    )
    enhanced = np.empty_like(audio, dtype=np.float32)
    for start in range(0, audio.size, SAMPLE_RATE):
        stop = min(start + SAMPLE_RATE, audio.size)
        enhanced[start:stop] = processor.process(audio[start:stop])
    if not np.isfinite(enhanced).all():
        raise ValueError("speech enhancement returned nonfinite samples")

    pcm = (np.clip(enhanced, -1.0, 1.0) * 32_767).astype("<i2")
    with tempfile.NamedTemporaryFile(prefix="openclaw-speech-", suffix=".wav", delete=False) as file:
        result = Path(file.name)
    try:
        with wave.open(str(result), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm.tobytes())
    except BaseException:
        result.unlink(missing_ok=True)
        raise
    return result
