from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from openclaw_local_tts.audio import FfmpegAudioEncoder, join_speech_segments
from openclaw_local_tts.types import RenderedPcm


def test_wav_encoding_uses_bounded_in_process_wrapper() -> None:
    encoder = FfmpegAudioEncoder(ffmpeg_path=__import__("pathlib").Path(sys.executable))
    output = encoder.encode(
        RenderedPcm(data=b"\x00\x00\xff\x7f", sample_rate=24_000),
        output_format="wav",
        sample_rate=None,
    )
    assert output.startswith(b"RIFF")
    assert b"WAVE" in output[:16]
    assert len(output) == 48


def test_incomplete_pcm_is_rejected_before_encoder_execution() -> None:
    encoder = FfmpegAudioEncoder(ffmpeg_path=__import__("pathlib").Path(sys.executable))
    with pytest.raises(ValueError, match="empty or incomplete"):
        encoder.encode(
            RenderedPcm(data=b"\x00", sample_rate=24_000),
            output_format="opus",
            sample_rate=None,
        )


def test_encoder_failure_does_not_expose_subprocess_output(monkeypatch) -> None:
    encoder = FfmpegAudioEncoder(ffmpeg_path=__import__("pathlib").Path(sys.executable))
    monkeypatch.setattr(
        "openclaw_local_tts.audio.subprocess.run",
        lambda *args, **kwargs: SimpleNamespace(returncode=1, stdout=b"sensitive detail"),
    )
    with pytest.raises(RuntimeError, match="^audio encoding failed$"):
        encoder.encode(
            RenderedPcm(data=b"\x00\x00", sample_rate=24_000),
            output_format="opus",
            sample_rate=None,
        )


def test_speech_segments_are_joined_in_order_with_bounded_pause() -> None:
    joined = join_speech_segments(
        [
            RenderedPcm(data=b"\x01\x00", sample_rate=1000),
            RenderedPcm(data=b"\x02\x00", sample_rate=1000),
        ],
        [2, 180],
    )

    assert joined.sample_rate == 1000
    assert joined.data == b"\x01\x00" + b"\x00\x00" * 2 + b"\x02\x00"
