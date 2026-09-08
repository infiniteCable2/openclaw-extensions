from __future__ import annotations

import json
import math
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any

from openclaw_accelerator import AcceleratorDemandLease


class EmbeddingRuntimeError(RuntimeError):
    pass


class OllamaEmbeddingRuntime:
    """Own Ollama embedding requests and the accelerator lease around them."""

    def __init__(
        self,
        *,
        model: str,
        dimensions: int,
        ollama_base_url: str,
        socket_path: Path,
        idle_release_seconds: float,
        request_timeout_seconds: float,
        request_keep_alive_seconds: float,
        minimum_vram_ratio: float = 0.95,
        demand_lease_factory: Any = AcceleratorDemandLease,
    ) -> None:
        if not model or any(ch.isspace() for ch in model):
            raise ValueError("model identifier is invalid")
        if not 1 <= dimensions <= 65_536:
            raise ValueError("embedding dimensions are outside the allowed range")
        if ollama_base_url not in {"http://127.0.0.1:11434", "http://localhost:11434"}:
            raise ValueError("Ollama must use the dedicated loopback endpoint")
        if not 1 <= request_timeout_seconds <= 300:
            raise ValueError("request timeout is outside the allowed range")
        if not 0 < minimum_vram_ratio <= 1:
            raise ValueError("minimum VRAM ratio is outside the allowed range")
        self.model = model
        self.dimensions = dimensions
        self.base_url = ollama_base_url.rstrip("/")
        self.request_timeout_seconds = float(request_timeout_seconds)
        self.request_keep_alive_seconds = float(request_keep_alive_seconds)
        self.minimum_vram_ratio = float(minimum_vram_ratio)
        self._stop = threading.Event()
        self._lease = demand_lease_factory(
            accelerator_id="gpu0",
            consumer="openclaw-embedding",
            socket_path=socket_path,
            ttl_seconds=90,
            renew_interval_seconds=25,
            failure_grace_seconds=30,
            idle_release_seconds=idle_release_seconds,
            acquire_timeout_seconds=90,
            quiesce=self._unload_and_verify,
        )
        self._drainer = threading.Thread(target=self._drain_loop, name="embedding-idle-drain", daemon=True)
        self._drainer.start()

    def _request_json(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = None if payload is None else json.dumps(payload, allow_nan=False).encode("utf-8")
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.request_timeout_seconds) as response:
                raw = response.read(16 * 1024 * 1024 + 1)
        except Exception as exc:
            raise EmbeddingRuntimeError("Ollama embedding transport failed") from exc
        if len(raw) > 16 * 1024 * 1024:
            raise EmbeddingRuntimeError("Ollama response exceeds the size limit")
        try:
            value = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise EmbeddingRuntimeError("Ollama returned invalid JSON") from exc
        if not isinstance(value, dict):
            raise EmbeddingRuntimeError("Ollama returned an invalid response object")
        return value

    def embed(self, inputs: list[str]) -> list[list[float]]:
        with self._lease.activity():
            response = self._request_json(
                "POST",
                "/api/embed",
                {
                    "model": self.model,
                    "input": inputs,
                    "keep_alive": f"{self.request_keep_alive_seconds:g}s",
                },
            )
            self._verify_gpu_residency()
        embeddings = response.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(inputs):
            raise EmbeddingRuntimeError("Ollama returned the wrong embedding count")
        validated: list[list[float]] = []
        for vector in embeddings:
            if not isinstance(vector, list) or len(vector) != self.dimensions:
                raise EmbeddingRuntimeError("Ollama returned the wrong embedding dimensions")
            normalized: list[float] = []
            nonzero = False
            for item in vector:
                if isinstance(item, bool) or not isinstance(item, (int, float)):
                    raise EmbeddingRuntimeError("Ollama returned a non-numeric embedding")
                number = float(item)
                if not math.isfinite(number):
                    raise EmbeddingRuntimeError("Ollama returned a non-finite embedding")
                nonzero = nonzero or number != 0.0
                normalized.append(number)
            if not nonzero:
                raise EmbeddingRuntimeError("Ollama returned a zero embedding")
            validated.append(normalized)
        return validated

    def _verify_gpu_residency(self) -> None:
        models = self._request_json("GET", "/api/ps").get("models")
        if not isinstance(models, list):
            raise EmbeddingRuntimeError("Ollama process inventory is invalid")
        for entry in models:
            if not isinstance(entry, dict) or self.model not in {entry.get("name"), entry.get("model")}:
                continue
            size = entry.get("size")
            size_vram = entry.get("size_vram")
            if (
                isinstance(size, bool)
                or not isinstance(size, (int, float))
                or isinstance(size_vram, bool)
                or not isinstance(size_vram, (int, float))
                or size <= 0
                or size_vram / size < self.minimum_vram_ratio
            ):
                raise EmbeddingRuntimeError("Ollama did not prove GPU residency")
            return
        raise EmbeddingRuntimeError("Ollama did not report the embedding model as resident")

    def _unload_and_verify(self) -> None:
        self._request_json(
            "POST",
            "/api/generate",
            {"model": self.model, "keep_alive": 0, "stream": False},
        )
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            models = self._request_json("GET", "/api/ps").get("models")
            if isinstance(models, list) and not models:
                return
            time.sleep(0.25)
        raise EmbeddingRuntimeError("Ollama did not unload all resident models")

    def _drain_loop(self) -> None:
        while not self._stop.wait(1.0):
            self._lease.drain_if_idle()

    def close(self) -> None:
        self._stop.set()
        self._drainer.join(timeout=2)
        self._lease.close()
