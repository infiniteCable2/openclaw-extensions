from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np

from openclaw_local_stt.speech_frontend import SAMPLE_RATE, enhance_speech_file


def test_web_rtc_frontend_preserves_speech_duration_and_bounds_output(tmp_path: Path) -> None:
    source = tmp_path / "quiet.wav"
    t = np.arange(SAMPLE_RATE, dtype=np.float32) / SAMPLE_RATE
    quiet_speech = (np.sin(2 * math.pi * 330 * t) * 0.015 * 32767).astype("<i2")
    with wave.open(str(source), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(quiet_speech.tobytes())

    processed = enhance_speech_file(source)
    try:
        with wave.open(str(processed), "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getframerate() == SAMPLE_RATE
            assert wav.getnframes() == SAMPLE_RATE
            samples = np.frombuffer(wav.readframes(SAMPLE_RATE), dtype="<i2")
        assert samples.size == quiet_speech.size
        assert np.max(np.abs(samples.astype(np.int32))) <= 32767
        assert np.any(samples != 0)
    finally:
        processed.unlink(missing_ok=True)
