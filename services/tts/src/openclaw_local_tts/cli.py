from __future__ import annotations

import argparse
from pathlib import Path

from waitress import serve

from .app import create_app
from .audio import FfmpegAudioEncoder
from .backend import ChatterboxBackend


def _voice_reference(value: str) -> tuple[str, Path]:
    voice_id, separator, path = value.partition("=")
    if not separator or not voice_id.strip() or not path.strip():
        raise argparse.ArgumentTypeError("voice reference must be VOICE_ID=/absolute/file.wav")
    return voice_id.strip(), Path(path.strip())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw local CUDA TTS service")
    parser.add_argument("--host", default="127.0.0.1", choices=["127.0.0.1", "::1"])
    parser.add_argument("--port", type=int, default=8020)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--model-id", default="chatterbox")
    parser.add_argument("--voice-reference", action="append", type=_voice_reference, required=True)
    parser.add_argument("--default-voice", default="default")
    parser.add_argument("--language", default="de")
    parser.add_argument("--chatterbox-source", type=Path, required=True)
    parser.add_argument("--perth-source", type=Path, required=True)
    parser.add_argument("--s3tokenizer-source", type=Path, required=True)
    parser.add_argument("--ffmpeg-path", type=Path, default=Path("/usr/bin/ffmpeg"))
    parser.add_argument("--max-text-characters", type=int, default=4096)
    parser.add_argument("--max-audio-bytes", type=int, default=64 * 1024 * 1024)
    parser.add_argument("--max-queued-requests", type=int, default=2)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("port is outside its allowed range")
    voice_references = dict(args.voice_reference)
    if len(voice_references) != len(args.voice_reference):
        raise SystemExit("voice reference ids must be unique")
    backend = ChatterboxBackend(
        model_path=args.model_path,
        voice_references=voice_references,
        default_voice=args.default_voice,
        chatterbox_source=args.chatterbox_source,
        perth_source=args.perth_source,
        s3tokenizer_source=args.s3tokenizer_source,
        model_id=args.model_id,
        language=args.language,
    )
    encoder = FfmpegAudioEncoder(
        ffmpeg_path=args.ffmpeg_path,
        max_output_bytes=args.max_audio_bytes,
    )
    app = create_app(
        backend,
        encoder,
        max_text_characters=args.max_text_characters,
        max_queued_requests=args.max_queued_requests,
    )
    serve(app, host=args.host, port=args.port, threads=4, clear_untrusted_proxy_headers=True)


if __name__ == "__main__":
    main()
