from __future__ import annotations

import argparse
import signal
import threading
from pathlib import Path

from .runtime import OllamaEmbeddingRuntime
from .server import EmbeddingServer


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenClaw local embedding service")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "::1"])
    parser.add_argument("--port", type=int, default=11436)
    parser.add_argument("--model", default="qwen3-embedding:0.6b")
    parser.add_argument("--dimensions", type=int, default=1024)
    parser.add_argument("--accelerator-socket", type=Path, default=Path("/run/openclaw-accelerator/broker.sock"))
    parser.add_argument("--idle-release-seconds", type=float, default=120)
    args = parser.parse_args()
    runtime = OllamaEmbeddingRuntime(
        model=args.model,
        dimensions=args.dimensions,
        ollama_base_url="http://127.0.0.1:11434",
        socket_path=args.accelerator_socket,
        idle_release_seconds=args.idle_release_seconds,
        request_timeout_seconds=60,
        request_keep_alive_seconds=max(5, args.idle_release_seconds + 30),
        minimum_vram_ratio=0.95,
    )
    server = EmbeddingServer(
        (args.host, args.port),
        runtime,
        max_body_bytes=1_048_576,
        max_inputs=32,
        max_input_chars=100_000,
        max_parallel=1,
        max_queued=32,
    )
    stop = threading.Event()

    def shutdown(_signum: int, _frame: object) -> None:
        if stop.is_set():
            return
        stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        runtime.close()


if __name__ == "__main__":
    main()
