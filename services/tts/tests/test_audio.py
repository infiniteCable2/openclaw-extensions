from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
from pathlib import Path
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
        "openclaw_local_tts.audio.subprocess.Popen",
        lambda *args, **kwargs: SimpleNamespace(
            returncode=1, communicate=lambda **kw: (b"sensitive detail", None),
        ),
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


def test_native_pcm_is_bit_exact_without_a_codec_process(monkeypatch):
    encoder = FfmpegAudioEncoder(ffmpeg_path=__import__("pathlib").Path(sys.executable))
    monkeypatch.setattr("openclaw_local_tts.audio.subprocess.Popen", lambda *a, **k: pytest.fail("codec launched"))
    pcm = b"\x00\x80\x34\x12\xff\x7f"
    assert encoder.encode(RenderedPcm(pcm, 24000), output_format="pcm", sample_rate=24000) == pcm


@pytest.mark.parametrize("stop", ["cancel", "deadline"])
def test_codec_is_killed_and_reaped_on_cancellation_or_deadline(monkeypatch, stop):
    calls = []
    started = threading.Event()
    killed = threading.Event()
    class Process:
        def communicate(self, **kwargs):
            calls.append("wait")
            started.set()
            assert killed.wait(timeout=2)
            calls.append("reaped")
            return b"", None
        def kill(self):
            calls.append("killed")
            killed.set()
        def wait(self):
            assert killed.is_set()
            return -9
    monkeypatch.setattr("openclaw_local_tts.audio.subprocess.Popen", lambda *a, **k: Process())
    now = 0.0
    monkeypatch.setattr("openclaw_local_tts.audio.time.monotonic", lambda: now)
    checkpoints = 0
    def checkpoint():
        nonlocal checkpoints, now
        checkpoints += 1
        if checkpoints > 1:
            assert started.wait(timeout=2)
            if stop == "cancel":
                raise RuntimeError("cancelled")
            now = 121.0
    encoder = FfmpegAudioEncoder(ffmpeg_path=__import__("pathlib").Path(sys.executable))
    error = RuntimeError if stop == "cancel" else subprocess.TimeoutExpired
    with pytest.raises(error):
        encoder.encode(RenderedPcm(b"\x00\x00", 24000), output_format="opus", sample_rate=None, checkpoint=checkpoint)
    assert calls == ["wait", "killed", "reaped"]


def test_codec_is_reaped_when_communicator_cannot_start(monkeypatch):
    calls = []
    class Process:
        def kill(self):
            calls.append("killed")
        def communicate(self):
            calls.append("drained")
            return b"", None
        def wait(self):
            calls.append("reaped")
            return -9
    def cannot_submit(*args, **kwargs):
        raise RuntimeError("cannot start communicator")
    monkeypatch.setattr("openclaw_local_tts.audio.subprocess.Popen", lambda *a, **k: Process())
    monkeypatch.setattr("openclaw_local_tts.audio.ThreadPoolExecutor.submit", cannot_submit)
    encoder = FfmpegAudioEncoder(ffmpeg_path=Path(sys.executable))
    with pytest.raises(RuntimeError, match="cannot start communicator"):
        encoder.encode(RenderedPcm(b"\x00\x00", 24000), output_format="opus", sample_rate=None)
    assert calls == ["killed", "drained", "reaped"]


def test_codec_completion_racing_watchdog_timeout_returns_output(monkeypatch):
    class CompletedFuture:
        def result(self, timeout=None):
            if timeout is not None:
                raise TimeoutError()
            return b"encoded", None
        def done(self):
            return True
    monkeypatch.setattr(
        "openclaw_local_tts.audio.ThreadPoolExecutor.submit",
        lambda *a, **k: CompletedFuture(),
    )
    monkeypatch.setattr(
        "openclaw_local_tts.audio.subprocess.Popen",
        lambda *a, **k: SimpleNamespace(
            returncode=0, communicate=lambda **kw: (b"encoded", None),
            kill=lambda: pytest.fail("completed codec was cancelled"),
        ),
    )
    encoder = FfmpegAudioEncoder(ffmpeg_path=Path(sys.executable))
    assert encoder.encode(
        RenderedPcm(b"\x00\x00", 24000), output_format="opus", sample_rate=None,
    ) == b"encoded"


@pytest.mark.skipif(os.name != "posix", reason="exercises POSIX pipe backpressure")
def test_codec_receives_all_pcm_after_a_watchdog_poll(monkeypatch):
    # The child cannot consume stdin until a watchdog poll has elapsed. This
    # makes the old retry-without-input bug deterministic, even on fast hosts.
    gate_read, gate_write = os.pipe()
    real_popen = subprocess.Popen
    children = []
    child_code = (
        "import hashlib,os,sys; "
        "os.read(int(sys.argv[1]),1); "
        "data=sys.stdin.buffer.read(); "
        "sys.stdout.buffer.write(hashlib.sha256(data).digest())"
    )
    def spawn(*args, **kwargs):
        child = real_popen(
            [sys.executable, "-c", child_code, str(gate_read)],
            pass_fds=(gate_read,),
            **kwargs,
        )
        children.append(child)
        return child
    monkeypatch.setattr("openclaw_local_tts.audio.subprocess.Popen", spawn)
    checkpoints = 0
    def checkpoint():
        nonlocal checkpoints
        checkpoints += 1
        if checkpoints == 3:
            os.write(gate_write, b"1")
    pcm = b"\x34\x12" * (256 * 1024)
    encoder = FfmpegAudioEncoder(ffmpeg_path=Path(sys.executable), timeout_seconds=2)
    try:
        encoded = encoder.encode(
            RenderedPcm(pcm, 24000), output_format="opus", sample_rate=None,
            checkpoint=checkpoint,
        )
        assert encoded == hashlib.sha256(pcm).digest()
        assert checkpoints >= 3
        assert children[0].poll() == 0
    finally:
        os.close(gate_read)
        os.close(gate_write)
