from __future__ import annotations

import threading
import time
import uuid

import pytest

from openclaw_local_stt.request_lifecycle import (
    RequestRegistry, RequestWork, ServiceError, ServiceState,
)


def test_prearrival_cancellation_is_idempotent_and_cannot_be_resurrected():
    registry = RequestRegistry()
    identifier = str(uuid.uuid4())
    registry.cancel(identifier)
    registry.cancel(identifier)
    with pytest.raises(ServiceError) as error:
        registry.register({"X-OpenClaw-Request-Id": identifier})
    assert error.value.code == "cancelled"


def test_duplicates_and_retired_ids_fail_closed_but_other_service_is_independent():
    registry = RequestRegistry()
    identifier = str(uuid.uuid4())
    work = registry.register({"X-OpenClaw-Request-Id": identifier})
    with pytest.raises(ServiceError):
        registry.register({"X-OpenClaw-Request-Id": identifier})
    other = RequestRegistry().register({"X-OpenClaw-Request-Id": identifier})
    registry.cancel(identifier)
    with pytest.raises(ServiceError) as error:
        work.checkpoint()
    assert error.value.code == "cancelled"
    other.checkpoint()
    registry.finish(work)
    registry.finish(work)
    with pytest.raises(ServiceError):
        registry.register({"X-OpenClaw-Request-Id": identifier})


@pytest.mark.parametrize("value", ["0", "300001", "1.5", "-1", "NaN", "9" * 5000])
def test_invalid_timeout_is_always_a_bounded_client_error(value):
    with pytest.raises(ServiceError) as error:
        RequestRegistry().register({"X-OpenClaw-Request-Timeout-Ms": value})
    assert error.value.status == 400


def test_registry_is_bounded_including_precancel_tombstones():
    registry = RequestRegistry(capacity=1)
    registry.cancel(str(uuid.uuid4()))
    with pytest.raises(ServiceError) as error:
        registry.cancel(str(uuid.uuid4()))
    assert error.value.status == 429


@pytest.mark.parametrize("cancelled", [False, True])
def test_queued_deadline_or_cancellation_skips_inference_and_cleans_counters(cancelled):
    state = ServiceState(capacity=2)
    work = RequestWork(str(uuid.uuid4()), time.monotonic() + 0.03)
    if cancelled:
        work.cancelled.set()
    errors = []
    reached = []
    with state.admit():
        def waiting():
            try:
                with state.admit(work):
                    reached.append(True)
            except ServiceError as error:
                errors.append(error.code)
        thread = threading.Thread(target=waiting)
        thread.start()
        thread.join(timeout=1)
        assert not thread.is_alive()
        assert state.snapshot() == (1, 0)
    assert reached == []
    assert errors == ["cancelled" if cancelled else "deadline_exceeded"]
    assert state.snapshot() == (0, 0)


def test_cancelled_fifo_head_does_not_block_next_waiter():
    state = ServiceState(capacity=3)
    cancelled = RequestWork(str(uuid.uuid4()), time.monotonic() + 2)
    second = RequestWork(str(uuid.uuid4()), time.monotonic() + 2)
    completed = []
    def run(work, label):
        try:
            with state.admit(work):
                completed.append(label)
        except ServiceError:
            completed.append("cancelled")
    with state.admit():
        first_thread = threading.Thread(target=run, args=(cancelled, "first"))
        first_thread.start()
        limit = time.monotonic() + 1
        while state.snapshot()[1] != 1 and time.monotonic() < limit:
            time.sleep(0.001)
        second_thread = threading.Thread(target=run, args=(second, "second"))
        second_thread.start()
        cancelled.cancelled.set()
        first_thread.join(timeout=1)
        assert not first_thread.is_alive()
    second_thread.join(timeout=1)
    assert not second_thread.is_alive()
    assert completed == ["cancelled", "second"]
    assert state.snapshot() == (0, 0)

