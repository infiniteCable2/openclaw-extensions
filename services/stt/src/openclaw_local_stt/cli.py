from __future__ import annotations

import argparse
from pathlib import Path

from waitress import serve

from .app import create_app
from .backend import FasterWhisperBackend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw local CUDA STT service")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "::1"])
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--model-id", default="faster-whisper")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--max-audio-bytes", type=int, default=20 * 1024 * 1024)
    parser.add_argument("--max-queued-requests", type=int, default=2)
    parser.add_argument("--no-vad-filter", action="store_true")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("port is outside its allowed range")
    backend = FasterWhisperBackend(
        model_path=args.model_path,
        model_id=args.model_id,
        compute_type=args.compute_type,
        vad_filter=not args.no_vad_filter,
    )
    app = create_app(
        backend,
        max_audio_bytes=args.max_audio_bytes,
        max_queued_requests=args.max_queued_requests,
    )
    serve(app, host=args.host, port=args.port, threads=4, clear_untrusted_proxy_headers=True)


if __name__ == "__main__":
    main()
