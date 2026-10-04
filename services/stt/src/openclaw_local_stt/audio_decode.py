"""Decode local audio incrementally with a decoded-sample budget."""
from __future__ import annotations

from collections.abc import Callable
from io import BytesIO
from pathlib import Path

from .request_lifecycle import ServiceError

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 15 * 60


def decode_bounded_audio(
    source: Path, *, checkpoint: Callable[[], None] = lambda: None,
    max_seconds: int = MAX_AUDIO_SECONDS,
):
    import av
    import numpy as np

    if not 1 <= max_seconds <= MAX_AUDIO_SECONDS:
        raise ValueError("decoded duration limit is invalid")
    checkpoint()
    limit = SAMPLE_RATE * max_seconds
    output = BytesIO()
    samples = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    def append(frames):
        nonlocal samples
        for frame in frames:
            checkpoint()
            samples += frame.samples
            if samples > limit:
                raise ServiceError(
                    "payload_too_large", "decoded audio exceeds the duration limit",
                    413, retryable=False,
                )
            output.write(frame.to_ndarray().astype("<i2", copy=False).tobytes())

    # Supplying a Python file object restricts decoding to the uploaded bytes.
    # Disable external protocols and playlist/concat demuxers explicitly: an
    # upload's extension/content-type is not a trustworthy format declaration.
    options = {
        "protocol_whitelist": "",
        "format_whitelist": "wav,flac,ogg,mp3,aac,mov,matroska,webm",
    }
    with source.open("rb") as upload, av.open(
        upload, mode="r", metadata_errors="ignore", options=options,
    ) as container:
        for frame in container.decode(audio=0):
            checkpoint()
            # Discontinuous timestamps must not create unbounded inserted silence.
            frame.pts = None
            append(resampler.resample(frame))
        append(resampler.resample(None))
    checkpoint()
    if not samples:
        raise ServiceError("invalid_request", "decoded audio is empty", 400, retryable=False)
    return np.frombuffer(output.getbuffer(), dtype="<i2").astype(np.float32) / 32768.0
