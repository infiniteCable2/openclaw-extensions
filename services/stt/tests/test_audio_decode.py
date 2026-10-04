from __future__ import annotations

import wave

import numpy as np
import pytest

from openclaw_local_stt.audio_decode import decode_bounded_audio
from openclaw_local_stt.request_lifecycle import ServiceError


def write_wave(path, *, frames, rate=16000):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x10" * frames)


def test_decode_bounds_actual_samples_before_whole_file_materialization(tmp_path):
    source = tmp_path / "long.wav"
    write_wave(source, frames=16000 * 3)
    checkpoints = []
    with pytest.raises(ServiceError) as error:
        decode_bounded_audio(source, max_seconds=1, checkpoint=lambda: checkpoints.append(True))
    assert error.value.code == "payload_too_large"
    assert error.value.status == 413
    assert len(checkpoints) > 1


def test_decode_preserves_exact_native_pcm_and_resamples_other_rates(tmp_path):
    source = tmp_path / "native.wav"
    write_wave(source, frames=1600)
    audio = decode_bounded_audio(source)
    assert audio.shape == (1600,)
    assert np.all(audio == 4096 / 32768)
    write_wave(source, frames=4800, rate=48000)
    assert decode_bounded_audio(source).shape == (1600,)


def test_decode_cancellation_checked_during_frames(tmp_path):
    source = tmp_path / "audio.wav"
    write_wave(source, frames=16000 * 3)
    calls = [0]
    def check():
        calls[0] += 1
        if calls[0] == 3:
            raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        decode_bounded_audio(source, checkpoint=check)
    assert calls[0] == 3


def test_playlist_cannot_reference_secondary_local_media(tmp_path):
    import av
    nested = tmp_path / "nested.wav"
    write_wave(nested, frames=1600)
    source = tmp_path / "upload.wav"
    source.write_text(f"ffconcat version 1.0\nfile '{nested.as_posix()}'\n", encoding="utf-8")
    with pytest.raises(av.error.FFmpegError):
        decode_bounded_audio(source)


def test_decode_requires_nonempty_audio(tmp_path):
    source = tmp_path / "empty.wav"
    write_wave(source, frames=0)
    with pytest.raises(ServiceError, match="empty"):
        decode_bounded_audio(source)


@pytest.mark.parametrize(
    ("container_format", "codec", "suffix"),
    [("ogg", "libopus", ".ogg"), ("webm", "libopus", ".webm"), ("mp4", "aac", ".m4a")],
)
def test_decode_accepts_matrix_audio_containers(tmp_path, container_format, codec, suffix):
    import av

    source = tmp_path / ("ordinary-upload" + suffix)
    rate = 48_000
    sample_count = rate // 4
    signal = (0.2 * np.sin(2 * np.pi * 440 * np.arange(sample_count) / rate)).astype(np.float32)
    with av.open(str(source), mode="w", format=container_format) as output:
        stream = output.add_stream(codec, rate=rate)
        stream.layout = "mono"
        frame = av.AudioFrame.from_ndarray(signal.reshape(1, -1), format="fltp", layout="mono")
        frame.sample_rate = rate
        frame.pts = 0
        for packet in stream.encode(frame):
            output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)

    # Lossy codec priming/padding differs; assert meaningful bounded decoded
    # speech-rate samples rather than falsely requiring bit-exact round trips.
    decoded = decode_bounded_audio(source, max_seconds=1)
    assert 3_500 <= decoded.size <= 5_000
    assert np.isfinite(decoded).all()
    assert 0.05 < np.sqrt(np.mean(decoded**2)) < 0.3
