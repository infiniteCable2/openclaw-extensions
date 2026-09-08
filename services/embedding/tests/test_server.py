from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

from openclaw_local_embedding.server import EmbeddingServer


class FakeRuntime:
    model = "qwen3-embedding:0.6b"

    def embed(self, inputs: list[str]) -> list[list[float]]:
        return [[1.0, 0.0] for _ in inputs]


def request(url: str, payload: dict[str, object]) -> tuple[int, dict[str, object]]:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def test_embed_endpoint_validates_model_and_returns_vectors() -> None:
    server = EmbeddingServer(
        ("127.0.0.1", 0),
        FakeRuntime(),  # type: ignore[arg-type]
        max_body_bytes=4096,
        max_inputs=4,
        max_input_chars=100,
        max_parallel=1,
        max_queued=1,
    )
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}/api/embed"
        status, body = request(base, {"model": FakeRuntime.model, "input": ["eins", "zwei"]})
        assert status == 200
        assert body["embeddings"] == [[1.0, 0.0], [1.0, 0.0]]
        status, body = request(base, {"model": "wrong", "input": "eins"})
        assert status == 400
        assert body == {"error": "unsupported_model"}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
