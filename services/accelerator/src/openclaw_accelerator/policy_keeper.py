from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable

from .client import AcceleratorClient, AcceleratorPolicyLease, BrokerError


class AcceleratorPolicyKeeper:
    """Retain a CPU-only policy binding while its model and GPU lease are absent."""

    def __init__(
        self,
        *,
        accelerator_id: str,
        consumer: str,
        socket_path: Path,
        ttl_seconds: float = 90,
        renew_interval_seconds: float = 20,
        client: AcceleratorClient | None = None,
        epoch: Callable[[], float] = time.time,
    ) -> None:
        if not 5 <= ttl_seconds <= 86_400:
            raise ValueError("policy lease TTL is outside its allowed range")
        if not 0 < renew_interval_seconds <= ttl_seconds / 2:
            raise ValueError("policy renewal interval is invalid")
        self.accelerator_id = accelerator_id
        self.consumer = consumer
        self.ttl_seconds = float(ttl_seconds)
        self.renew_interval_seconds = float(renew_interval_seconds)
        self.client = client or AcceleratorClient(socket_path, timeout_seconds=10.0)
        self._epoch = epoch
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self.changed = threading.Event()
        self._lease: AcceleratorPolicyLease | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                raise RuntimeError("policy keeper is already started")
        self._refresh()
        self._thread = threading.Thread(target=self._monitor, name=f"policy-{self.consumer}", daemon=True)
        self._thread.start()

    def _refresh(self) -> None:
        with self._lock:
            lease = self._lease
        try:
            if lease is None:
                replacement = self.client.subscribe_policy(
                    self.accelerator_id, self.consumer, ttl_seconds=self.ttl_seconds,
                )
            else:
                lease.renew()
                replacement = lease
        except BrokerError as exc:
            if lease is not None and exc.code == "accelerator_lease_not_found":
                with self._lock:
                    self._lease = None
            self.changed.set()
            return
        except Exception:
            self.changed.set()
            return
        with self._lock:
            self._lease = replacement
        self.changed.set()

    def _monitor(self) -> None:
        while not self._stop.is_set():
            with self._lock:
                lease = self._lease
            until_policy = (lease.policy_valid_until_epoch - self._epoch() - 1
                            if lease is not None else self.renew_interval_seconds)
            delay = max(0.25, min(self.renew_interval_seconds, until_policy))
            if self._stop.wait(delay):
                return
            self._refresh()

    def unload_requested(self) -> bool | None:
        """None means policy authority is unavailable or expired; fail closed."""
        with self._lock:
            lease = self._lease
            if (lease is None or lease.released
                    or self._epoch() >= lease.expires_at_epoch
                    or self._epoch() >= lease.policy_valid_until_epoch):
                return None
            return lease.unload_requested

    def close(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=self.renew_interval_seconds + 1)
        with self._lock:
            lease = self._lease
            self._lease = None
        if lease is not None:
            try:
                lease.release()
            except BrokerError:
                pass
