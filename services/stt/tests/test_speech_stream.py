import subprocess
import sys


def test_stream_processes_ordered_frames_and_exits_cleanly():
    from openclaw_local_stt.speech_stream import FRAME_BYTES

    frame = b"\x00\x00" * (FRAME_BYTES // 2)
    process = subprocess.run(
        [sys.executable, "-m", "openclaw_local_stt.speech_stream"],
        input=frame * 3,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        check=True,
    )
    assert process.stdout[:4] == b"APM1"
    assert len(process.stdout) == 4 + FRAME_BYTES * 3


def test_stream_rejects_truncated_frame():
    process = subprocess.run(
        [sys.executable, "-m", "openclaw_local_stt.speech_stream"],
        input=b"\x00",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
    )
    assert process.returncode == 2
