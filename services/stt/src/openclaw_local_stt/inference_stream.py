"""Bounded SSE mailbox: decoding never waits for a response consumer."""
from __future__ import annotations

import logging
import threading
from collections import deque
from contextlib import closing
from typing import Callable, Iterator

from .request_lifecycle import RequestWork, ServiceError

_LOGGER = logging.getLogger(__name__)


class InferenceStream:
    """Keep request admission until both producer and HTTP response are finished.

    The producer owns complete utterance inference and its temporary files. A
    disconnected consumer cancels cooperatively, never closes a running decoder
    from another thread, and cannot release admission while inference still runs.
    """

    def __init__(
        self, *, work: RequestWork, produce: Callable[[], Iterator[bytes]],
        cleanup: Callable[[], None], release: Callable[[], None],
        error_event: Callable[[ServiceError | None], bytes],
        max_bytes: int = 1024 * 1024, max_events: int = 256,
    ) -> None:
        self.work = work
        self.produce = produce
        self.cleanup = cleanup
        self.release = release
        self.error_event = error_event
        self.max_bytes = max_bytes
        self.max_events = max_events
        self.condition = threading.Condition()
        self.events: deque[bytes] = deque()
        self.total_bytes = 0
        self.total_events = 0
        self.started = False
        self.done = False
        self.closed = False
        self.released = False

    def _release_if_finished(self) -> None:
        # Caller holds the condition lock; release is non-blocking bookkeeping.
        if self.closed and self.done and not self.released:
            self.released = True
            self.release()

    def _cleanup(self) -> None:
        try:
            self.cleanup()
        except Exception as error:
            # Cleanup errors may contain private upload paths. Do not leak an
            # uncaught daemon-thread traceback or replace the inference result.
            _LOGGER.error("STT inference cleanup failed error_type=%s", type(error).__name__)

    def _append(self, event: bytes) -> None:
        with self.condition:
            self.work.checkpoint()
            if self.total_events >= self.max_events or self.total_bytes + len(event) > self.max_bytes:
                raise ServiceError(
                    "output_too_large", "STT event output exceeds its limit", 413, retryable=False,
                )
            self.total_events += 1
            self.total_bytes += len(event)
            self.events.append(event)
            self.condition.notify_all()

    def _run(self) -> None:
        try:
            with closing(self.produce()) as events:
                for event in events:
                    self._append(event)
        except Exception as error:
            # One small terminal error is outside the normal output allowance.
            with self.condition:
                if not self.closed:
                    self.events.append(self.error_event(error if isinstance(error, ServiceError) else None))
                    self.condition.notify_all()
        finally:
            try:
                self._cleanup()
            finally:
                with self.condition:
                    self.done = True
                    self._release_if_finished()
                    self.condition.notify_all()

    def __iter__(self) -> Iterator[bytes]:
        try:
            with self.condition:
                if self.closed:
                    return
                if self.started:
                    raise RuntimeError("inference response can only be consumed once")
                self.started = True
                try:
                    threading.Thread(target=self._run, name="stt-inference", daemon=True).start()
                except BaseException:
                    self.started = False
                    raise
            while True:
                with self.condition:
                    while not self.events and not self.done and not self.closed:
                        self.work.checkpoint()
                        self.condition.wait(timeout=0.05)
                    if self.closed:
                        return
                    self.work.checkpoint()
                    if not self.events:
                        return
                    event = self.events.popleft()
                yield event
        except ServiceError as error:
            yield self.error_event(error)
        finally:
            self.close()

    def close(self) -> None:
        with self.condition:
            if self.closed:
                return
            self.closed = True
            self.events.clear()
            if not self.done:
                self.work.cancelled.set()
            if not self.started:
                try:
                    self._cleanup()
                finally:
                    self.done = True
            self._release_if_finished()
            self.condition.notify_all()
