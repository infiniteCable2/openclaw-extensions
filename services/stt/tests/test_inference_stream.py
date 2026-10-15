from __future__ import annotations

import time
import uuid

import pytest

from openclaw_local_stt.inference_stream import InferenceStream
from openclaw_local_stt.request_lifecycle import RequestWork, ServiceError


@pytest.mark.parametrize("inference_fails", [False, True])
def test_cleanup_failure_is_content_free_and_preserves_terminal_result(
    caplog, capsys, inference_fails,
):
    private_path = "/private/example-upload/never-log-this.wav"
    releases = []

    def produce():
        yield b"confirmed"
        if inference_fails:
            raise ServiceError("inference_failed", "STT inference failed", 500, retryable=True)
        yield b"transcript.done"

    def cleanup():
        raise OSError(f"cannot delete {private_path}")

    stream = InferenceStream(
        work=RequestWork(str(uuid.uuid4()), time.monotonic() + 2),
        produce=produce, cleanup=cleanup, release=lambda: releases.append(True),
        error_event=lambda error: f"error:{error.code}".encode(),
    )
    assert list(stream) == [
        b"confirmed", b"error:inference_failed" if inference_fails else b"transcript.done",
    ]
    stream.close()
    assert stream.done and stream.closed and stream.released
    assert releases == [True]
    assert len(caplog.records) == 1
    assert caplog.records[0].getMessage() == "STT inference cleanup failed error_type=OSError"
    assert caplog.records[0].exc_info is None
    captured = capsys.readouterr()
    assert private_path not in caplog.text + captured.out + captured.err


def test_unstarted_cleanup_failure_still_releases_once_without_traceback(caplog):
    releases = []
    calls = []

    def produce():
        calls.append("inference")
        yield b"unexpected"

    def cleanup():
        raise OSError("private temporary path")

    stream = InferenceStream(
        work=RequestWork(str(uuid.uuid4()), time.monotonic() + 2),
        produce=produce, cleanup=cleanup, release=lambda: releases.append(True),
        error_event=lambda error: b"error",
    )
    stream.close()
    stream.close()
    assert calls == []
    assert stream.done and stream.closed and stream.released
    assert releases == [True]
    assert len(caplog.records) == 1
    assert "private temporary path" not in caplog.text
