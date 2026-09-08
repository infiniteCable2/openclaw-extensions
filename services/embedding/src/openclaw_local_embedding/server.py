from __future__ import annotations

import json
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .runtime import EmbeddingRuntimeError, OllamaEmbeddingRuntime


class EmbeddingServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        runtime: OllamaEmbeddingRuntime,
        *,
        max_body_bytes: int,
        max_inputs: int,
        max_input_chars: int,
        max_parallel: int,
        max_queued: int,
    ) -> None:
        super().__init__(address, EmbeddingHandler)
        self.runtime = runtime
        self.max_body_bytes = max_body_bytes
        self.max_inputs = max_inputs
        self.max_input_chars = max_input_chars
        self.admission = threading.BoundedSemaphore(max_parallel + max_queued)
        self.execution = threading.BoundedSemaphore(max_parallel)


class EmbeddingHandler(BaseHTTPRequestHandler):
    server: EmbeddingServer

    def log_message(self, format: str, *args: object) -> None:
        return

    def _json(self, status: HTTPStatus, value: dict[str, Any]) -> None:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(HTTPStatus.OK, {"ok": True, "service": "openclaw-local-embedding"})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/api/embed":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self.server.admission.acquire(blocking=False):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "queue_full"})
            return
        try:
            raw_length = self.headers.get("Content-Length", "")
            try:
                length = int(raw_length)
            except ValueError:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
                return
            if not 0 < length <= self.server.max_body_bytes:
                self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body_too_large"})
                return
            try:
                payload = json.loads(self.rfile.read(length))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_json"})
                return
            if not isinstance(payload, dict) or payload.get("model") != self.server.runtime.model:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "unsupported_model"})
                return
            value = payload.get("input")
            inputs = [value] if isinstance(value, str) else value
            if (
                not isinstance(inputs, list)
                or not 1 <= len(inputs) <= self.server.max_inputs
                or any(not isinstance(item, str) or not item or len(item) > self.server.max_input_chars for item in inputs)
            ):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid_input"})
                return
            with self.server.execution:
                try:
                    embeddings = self.server.runtime.embed(inputs)
                except EmbeddingRuntimeError:
                    self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "embedding_unavailable"})
                    return
            self._json(HTTPStatus.OK, {"model": self.server.runtime.model, "embeddings": embeddings})
        finally:
            self.server.admission.release()
