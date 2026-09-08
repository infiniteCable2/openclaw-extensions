from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

from .lease_keeper import AcceleratorLeaseKeeper


class AcceleratorDemandUnavailable(RuntimeError):
    pass


class AcceleratorDemandLease:
    """Keep a renewable lease while work is active or the service is warm."""

    def __init__(
        self,
        *,
        accelerator_id: str,
        consumer: str,
        socket_path: Path,
        ttl_seconds: float,
        renew_interval_seconds: float,
        failure_grace_seconds: float,
        idle_release_seconds: float,
        acquire_timeout_seconds: float,
        quiesce: Callable[[], None],
        keeper_factory: Callable[..., AcceleratorLeaseKeeper] = AcceleratorLeaseKeeper,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 0 < idle_release_seconds <= 86_400:
            raise ValueError("idle release is outside its allowed range")
        if not 0 < acquire_timeout_seconds <= 600:
            raise ValueError("acquire timeout is outside its allowed range")
        self._keeper_args = {
            "accelerator_id": accelerator_id,
            "consumer": consumer,
            "socket_path": Path(socket_path),
            "ttl_seconds": ttl_seconds,
            "renew_interval_seconds": renew_interval_seconds,
            "failure_grace_seconds": failure_grace_seconds,
        }
        self._idle_release_seconds = float(idle_release_seconds)
        self._acquire_timeout_seconds = float(acquire_timeout_seconds)
        self._quiesce = quiesce
        self._keeper_factory = keeper_factory
        self._monotonic = monotonic
        self._condition = threading.Condition(threading.RLock())
        self._keeper: AcceleratorLeaseKeeper | None = None
        self._transition = "idle"
        self._active = 0
        self._idle_since: float | None = None
        self._closing = False

    def acquire(self) -> None:
        deadline = self._monotonic() + self._acquire_timeout_seconds
        while True:
            with self._condition:
                if self._closing:
                    raise AcceleratorDemandUnavailable("demand lease is shutting down")
                if self._transition in {"acquiring", "draining"}:
                    remaining = deadline - self._monotonic()
                    if remaining <= 0:
                        raise AcceleratorDemandUnavailable("accelerator transition timed out")
                    self._condition.wait(timeout=min(0.25, remaining))
                    continue
                if self._keeper is not None:
                    if not self._keeper.healthy():
                        remaining = deadline - self._monotonic()
                        if remaining <= 0:
                            raise AcceleratorDemandUnavailable("accelerator lease is unavailable")
                        self._condition.wait(timeout=min(0.25, remaining))
                        continue
                    self._active += 1
                    self._idle_since = None
                    return
                self._transition = "acquiring"
                break
        keeper = self._keeper_factory(**self._keeper_args)
        try:
            keeper.start()
        except Exception as exc:
            with self._condition:
                self._transition = "idle"
                self._condition.notify_all()
            raise AcceleratorDemandUnavailable("accelerator acquisition failed") from exc
        with self._condition:
            if self._closing:
                self._transition = "draining"
            else:
                self._keeper = keeper
                self._active = 1
                self._idle_since = None
                self._transition = "ready"
                self._condition.notify_all()
                return
        keeper.close()
        raise AcceleratorDemandUnavailable("demand lease shut down during acquisition")

    def release(self) -> None:
        with self._condition:
            if self._active <= 0:
                raise RuntimeError("unbalanced demand lease release")
            self._active -= 1
            if self._active == 0:
                self._idle_since = self._monotonic()
            self._condition.notify_all()

    @contextmanager
    def activity(self) -> Iterator[None]:
        self.acquire()
        try:
            yield
        finally:
            self.release()

    def drain_if_idle(self) -> bool:
        with self._condition:
            keeper = self._keeper
            if (
                self._closing
                or keeper is None
                or self._transition != "ready"
                or self._active != 0
                or self._idle_since is None
                or self._monotonic() - self._idle_since < self._idle_release_seconds
            ):
                return False
            self._transition = "draining"
        try:
            self._quiesce()
            keeper.close()
        except Exception:
            with self._condition:
                self._transition = "ready"
                self._idle_since = self._monotonic()
                self._condition.notify_all()
            return False
        with self._condition:
            if self._keeper is keeper:
                self._keeper = None
            self._idle_since = None
            self._transition = "idle"
            self._condition.notify_all()
        return True

    def close(self) -> None:
        with self._condition:
            self._closing = True
            keeper = self._keeper
            if self._active:
                raise RuntimeError("cannot close a demand lease with active operations")
            self._transition = "draining" if keeper else "idle"
        if keeper:
            self._quiesce()
            keeper.close()
        with self._condition:
            self._keeper = None
            self._idle_since = None
            self._transition = "idle"
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closing = True
            keeper = self._keeper
            if keeper is not None:
                self._transition = "draining"
            self._condition.notify_all()
        if keeper is not None:
            self._quiesce()
            keeper.close()
        with self._condition:
            self._keeper = None
            self._active = 0
            self._idle_since = None
            self._transition = "idle"

    def ready(self) -> bool:
        with self._condition:
            return self._transition == "ready" and self._keeper is not None and self._keeper.healthy()
