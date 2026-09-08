from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable

from .client import AcceleratorClient, AcceleratorLease, BrokerError


class AcceleratorLeaseKeeper:
    """Maintain one renewable accelerator lease for a long-running consumer."""

    def __init__(
        self,
        *,
        accelerator_id: str,
        consumer: str,
        ttl_seconds: float,
        renew_interval_seconds: float,
        failure_grace_seconds: float,
        socket_path: Path,
        client: AcceleratorClient | None = None,
        on_unavailable: Callable[[], None] | None = None,
        on_restored: Callable[[], None] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 5 <= ttl_seconds <= 86_400:
            raise ValueError("lease TTL is outside its allowed range")
        if not 0 < renew_interval_seconds <= ttl_seconds / 2:
            raise ValueError("renew interval must be within half the lease TTL")
        if not 0 < failure_grace_seconds <= ttl_seconds:
            raise ValueError("failure grace must be within the lease TTL")
        self.accelerator_id = accelerator_id
        self.consumer = consumer
        self.ttl_seconds = float(ttl_seconds)
        self.renew_interval_seconds = float(renew_interval_seconds)
        self.failure_grace_seconds = float(failure_grace_seconds)
        self.client = client or AcceleratorClient(Path(socket_path), timeout_seconds=60.0)
        self.on_unavailable = on_unavailable
        self.on_restored = on_restored
        self._monotonic = monotonic
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lease: AcceleratorLease | None = None
        self._healthy = False
        self._last_success = 0.0

    def start(self) -> None:
        with self._lock:
            if self._lease is not None or self._thread is not None:
                raise RuntimeError("lease keeper is already started")
        lease = self.client.acquire(
            self.accelerator_id,
            self.consumer,
            ttl_seconds=self.ttl_seconds,
        )
        with self._lock:
            self._lease = lease
            self._healthy = True
            self._last_success = self._monotonic()
            self._thread = threading.Thread(
                target=self._monitor,
                name=f"accelerator-lease-{self.consumer}",
                daemon=True,
            )
            self._thread.start()

    def _set_unavailable(self) -> None:
        callback = None
        with self._lock:
            if self._healthy and self._monotonic() - self._last_success >= self.failure_grace_seconds:
                self._healthy = False
                callback = self.on_unavailable
        if callback:
            callback()

    def _maintain_once(self) -> None:
        with self._lock:
            lease = self._lease
        if lease is None:
            self._set_unavailable()
            return
        try:
            lease.renew()
        except BrokerError as exc:
            if exc.code == "accelerator_lease_not_found":
                try:
                    replacement = self.client.acquire(
                        self.accelerator_id,
                        self.consumer,
                        ttl_seconds=self.ttl_seconds,
                    )
                except Exception:
                    self._set_unavailable()
                    return
                with self._lock:
                    self._lease = replacement
                    was_healthy = self._healthy
                    self._healthy = True
                    self._last_success = self._monotonic()
                if not was_healthy and self.on_restored:
                    self.on_restored()
                return
            self._set_unavailable()
            return
        except Exception:
            self._set_unavailable()
            return
        with self._lock:
            was_healthy = self._healthy
            self._healthy = True
            self._last_success = self._monotonic()
        if not was_healthy and self.on_restored:
            self.on_restored()

    def _monitor(self) -> None:
        while not self._stop.wait(self.renew_interval_seconds):
            self._maintain_once()

    def healthy(self) -> bool:
        with self._lock:
            return self._healthy

    def close(self) -> None:
        self._stop.set()
        with self._lock:
            thread = self._thread
        if thread:
            thread.join(timeout=max(1.0, self.renew_interval_seconds + 1.0))
        with self._lock:
            lease = self._lease
            self._lease = None
            self._thread = None
            self._healthy = False
        if lease:
            lease.release()
