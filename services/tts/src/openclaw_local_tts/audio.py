from __future__ import annotations

import subprocess
import wave
from collections.abc import Sequence
from io import BytesIO
from pathlib import Path

from .types import RenderedPcm


def join_speech_segments(
    rendered_segments: Sequence[RenderedPcm],
    pauses_after_ms: Sequence[int],
) -> RenderedPcm:
    """Join ordered mono PCM segments, inserting silence only between them."""
    if not rendered_segments or len(rendered_segments) != len(pauses_after_ms):
        raise ValueError("rendered speech segments are incomplete")
    sample_rate = rendered_segments[0].sample_rate
    output = bytearray()
    for index, rendered in enumerate(rendered_segments):
        if rendered.sample_rate != sample_rate:
            raise ValueError("rendered speech segment sample rates differ")
        if not rendered.data or len(rendered.data) % 2:
            raise ValueError("rendered speech segment PCM is empty or incomplete")
        output.extend(rendered.data)
        if index < len(rendered_segments) - 1:
            pause_ms = pauses_after_ms[index]
            if pause_ms < 0 or pause_ms > 2000:
                raise ValueError("rendered speech segment pause is invalid")
            output.extend(b"\x00\x00" * (sample_rate * pause_ms // 1000))
    return RenderedPcm(data=bytes(output), sample_rate=sample_rate)


class FfmpegAudioEncoder:
    def __init__(
        self,
        *,
        ffmpeg_path: Path,
        timeout_seconds: float = 120.0,
        max_output_bytes: int = 64 * 1024 * 1024,
    ) -> None:
        if not ffmpeg_path.is_absolute():
            raise ValueError("ffmpeg_path must be absolute")
        self.ffmpeg_path = ffmpeg_path.resolve(strict=True)
        if not self.ffmpeg_path.is_file():
            raise ValueError("ffmpeg_path must be a file")
        if timeout_seconds <= 0 or timeout_seconds > 600:
            raise ValueError("encoder timeout is outside its allowed range")
        if max_output_bytes < 1024:
            raise ValueError("encoder output limit is too small")
        self.timeout_seconds = timeout_seconds
        self.max_output_bytes = max_output_bytes

    @staticmethod
    def _wav(rendered: RenderedPcm) -> bytes:
        output = BytesIO()
        with wave.open(output, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rendered.sample_rate)
            handle.writeframes(rendered.data)
        return output.getvalue()

    def encode(
        self,
        rendered: RenderedPcm,
        *,
        output_format: str,
        sample_rate: int | None,
    ) -> bytes:
        if not rendered.data or len(rendered.data) % 2:
            raise ValueError("rendered PCM is empty or incomplete")
        if output_format == "wav" and sample_rate in {None, rendered.sample_rate}:
            output = self._wav(rendered)
        else:
            target_rate = sample_rate or (48_000 if output_format == "opus" else rendered.sample_rate)
            if output_format == "pcm":
                output_args = ["-ar", str(target_rate), "-f", "s16le", "pipe:1"]
            elif output_format == "wav":
                output_args = ["-ar", str(target_rate), "-f", "wav", "pipe:1"]
            elif output_format == "opus":
                output_args = [
                    "-ar",
                    str(target_rate),
                    "-c:a",
                    "libopus",
                    "-application",
                    "voip",
                    "-f",
                    "ogg",
                    "pipe:1",
                ]
            else:
                raise ValueError("unsupported output format")
            command = [
                str(self.ffmpeg_path),
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                str(rendered.sample_rate),
                "-i",
                "pipe:0",
                *output_args,
            ]
            result = subprocess.run(
                command,
                input=rendered.data,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=self.timeout_seconds,
            )
            if result.returncode != 0 or not result.stdout:
                raise RuntimeError("audio encoding failed")
            output = result.stdout
        if len(output) > self.max_output_bytes:
            raise ValueError("encoded audio exceeds the configured size limit")
        return output
