"""Bounded local request lifecycle; wire contract: media-request-lifecycle-v1."""
from __future__ import annotations

import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Iterator, Mapping


class ServiceError(RuntimeError):
    def __init__(self, code: str, message: str, status: int, *, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable


@dataclass
class RequestWork:
    request_id: str
    deadline: float
    cancelled: threading.Event = field(default_factory=threading.Event)

    def checkpoint(self) -> None:
        if self.cancelled.is_set():
            raise ServiceError("cancelled", "request was cancelled", 409, retryable=False)
        if time.monotonic() >= self.deadline:
            raise ServiceError("deadline_exceeded", "request deadline exceeded", 408, retryable=True)


def request_id(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
        if str(parsed) != value.lower() or parsed.version != 4:
            raise ValueError
        return str(parsed)
    except (ValueError, AttributeError):
        raise ServiceError("invalid_request", "request ID must be a UUIDv4", 400, retryable=False) from None


class RequestRegistry:
    def __init__(self, *, timeout_ms: int = 300_000, capacity: int = 1024) -> None:
        if not 1 <= timeout_ms <= 300_000:
            raise ValueError("request timeout must be between 1 and 300000ms")
        self.timeout_ms = timeout_ms
        self.capacity = capacity
        self.lock = threading.Lock()
        self.active: dict[str, RequestWork] = {}
        self.retired: dict[str, float] = {}

    def _prune(self) -> None:
        now = time.monotonic()
        self.retired = {key: expiry for key, expiry in self.retired.items() if expiry > now}

    def _check_capacity(self) -> None:
        if len(self.active) + len(self.retired) >= self.capacity:
            raise ServiceError("overloaded", "request registry is full", 429, retryable=True)

    def register(self, headers: Mapping[str, str]) -> RequestWork:
        identifier = request_id(headers.get("X-OpenClaw-Request-Id", str(uuid.uuid4())))
        raw_timeout = headers.get("X-OpenClaw-Request-Timeout-Ms")
        timeout = self.timeout_ms
        if raw_timeout is not None:
            if len(raw_timeout) > 6 or not raw_timeout.isascii() or not raw_timeout.isdecimal():
                raise ServiceError("invalid_request", "request timeout is invalid", 400, retryable=False)
            timeout = int(raw_timeout)
            if timeout < 1 or timeout > 300_000:
                raise ServiceError("invalid_request", "request timeout is invalid", 400, retryable=False)
            timeout = min(timeout, self.timeout_ms)
        with self.lock:
            self._prune()
            if identifier in self.active or identifier in self.retired:
                raise ServiceError("cancelled", "request ID is unavailable", 409, retryable=False)
            self._check_capacity()
            work = RequestWork(identifier, time.monotonic() + timeout / 1000)
            self.active[identifier] = work
            return work

    def finish(self, work: RequestWork) -> None:
        with self.lock:
            if self.active.pop(work.request_id, None) is not None:
                self.retired[work.request_id] = time.monotonic() + 300

    def cancel(self, identifier: str) -> None:
        identifier = request_id(identifier)
        with self.lock:
            self._prune()
            if work := self.active.get(identifier):
                work.cancelled.set()
            elif identifier not in self.retired:
                self._check_capacity()
                self.retired[identifier] = time.monotonic() + 300


class ServiceState:
    """FIFO bounded inference admission with cooperative cancellation."""
    def __init__(self, *, capacity: int) -> None:
        self.capacity = capacity
        self.condition = threading.Condition()
        self.waiters: list[object] = []
        self.active_requests = 0

    @contextmanager
    def admit(self, work: RequestWork | None = None) -> Iterator[None]:
        ticket = object()
        admitted = False
        with self.condition:
            if self.active_requests + len(self.waiters) >= self.capacity:
                raise ServiceError("overloaded", "request queue is full", 429, retryable=True)
            self.waiters.append(ticket)
            try:
                while self.active_requests or self.waiters[0] is not ticket:
                    if work is not None:
                        work.checkpoint()
                    self.condition.wait(timeout=0.05)
                if work is not None:
                    work.checkpoint()
                self.waiters.pop(0)
                self.active_requests = 1
                admitted = True
            finally:
                if not admitted:
                    self.waiters.remove(ticket)
                    self.condition.notify_all()
        try:
            yield
        finally:
            with self.condition:
                self.active_requests = 0
                self.condition.notify_all()

    def snapshot(self) -> tuple[int, int]:
        with self.condition:
            return self.active_requests, len(self.waiters)

