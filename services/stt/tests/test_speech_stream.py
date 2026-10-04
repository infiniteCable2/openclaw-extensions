import subprocess
import sys
import struct


def test_stream_processes_ordered_frames_and_exits_cleanly():
    from openclaw_local_stt.speech_stream import CONTROL_FIELDS, FRAME_BYTES, METADATA_BYTES

    frame = b"\x00\x00" * (FRAME_BYTES // 2)
    process = subprocess.run(
        [sys.executable, "-m", "openclaw_local_stt.speech_stream"],
        input=frame * 3,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        check=True,
    )
    assert process.stdout[:4] == b"APM3"
    assert len(process.stdout) == 4 + (FRAME_BYTES + METADATA_BYTES) * 3
    for index in range(3):
        offset = 4 + index * (FRAME_BYTES + METADATA_BYTES) + FRAME_BYTES
        probability, gain_db = struct.unpack_from("<ff", process.stdout, offset)
        assert 0.0 <= probability <= 1.0
        assert -60.0 <= gain_db <= 60.0
        control = dict(zip(CONTROL_FIELDS, struct.unpack_from("<12f", process.stdout, offset + 8)))
        assert control["mutedFrames"] == control["nonspeechFrames"] == 2
        assert control["speechFrames"] == control["uncertainFrames"] == 0
        assert control["holdFrames"] == 2
        assert control["cleanRms"] == 0


def test_stream_rejects_truncated_frame():
    process = subprocess.run(
        [sys.executable, "-m", "openclaw_local_stt.speech_stream"],
        input=b"\x00",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
    )
    assert process.returncode == 2
