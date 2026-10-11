from __future__ import annotations

import argparse
from pathlib import Path

from waitress import serve

from .app import create_app
from .audio import FfmpegAudioEncoder
from .backend import ChatterboxBackend
from .voice_catalog import load_voice_catalog


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
    parser.add_argument("--backend", choices=["chatterbox", "kitten2"], default="chatterbox")
    parser.add_argument("--model-id")
    parser.add_argument("--kitten-weights", choices=["packed", "emb4"])
    parser.add_argument("--kitten-cache-dir", type=Path)
    parser.add_argument("--voice-catalog", type=Path)
    parser.add_argument("--voice-reference", action="append", type=_voice_reference, default=[])
    parser.add_argument("--default-voice")
    parser.add_argument("--language", default="de")
    parser.add_argument("--chatterbox-source", type=Path)
    parser.add_argument("--perth-source", type=Path)
    parser.add_argument("--s3tokenizer-source", type=Path)
    parser.add_argument("--ffmpeg-path", type=Path, default=Path("/usr/bin/ffmpeg"))
    parser.add_argument("--max-text-characters", type=int, default=4096)
    parser.add_argument("--max-audio-bytes", type=int, default=64 * 1024 * 1024)
    parser.add_argument("--max-queued-requests", type=int, default=2)
    parser.add_argument("--request-timeout-ms", type=int, default=300_000)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("port is outside its allowed range")
    if args.voice_catalog:
        if args.voice_reference or args.default_voice:
            raise SystemExit("voice catalog cannot be combined with direct voice arguments")
        catalog = load_voice_catalog(args.voice_catalog)
        voice_references = catalog.references
        default_voice = catalog.default_voice
        public_voices = catalog.public_voices
        voice_generation_settings = catalog.generation_settings
    else:
        if not args.voice_reference:
            raise SystemExit("voice catalog or at least one voice reference is required")
        voice_references = dict(args.voice_reference)
        if len(voice_references) != len(args.voice_reference):
            raise SystemExit("voice reference ids must be unique")
        default_voice = args.default_voice or "default"
        public_voices = None
        voice_generation_settings = None
    if args.backend == "kitten2":
        if not args.voice_catalog:
            raise SystemExit("KittenTTS 2 requires a voice catalog with reference_text")
        if args.kitten_cache_dir is None:
            raise SystemExit("KittenTTS 2 requires a separately provisioned offline codec cache")
        if args.chatterbox_source or args.perth_source or args.s3tokenizer_source:
            raise SystemExit("Chatterbox source arguments cannot be applied to KittenTTS 2")
        from .kitten_backend import KittenTts2Backend

        backend = KittenTts2Backend(
            model_path=args.model_path, cache_dir=args.kitten_cache_dir, catalog=catalog,
            model_id=args.model_id or "kitten-tts-2", weights=args.kitten_weights or "packed",
        )
    else:
        if args.kitten_weights is not None or args.kitten_cache_dir is not None:
            raise SystemExit("Kitten arguments cannot be applied to Chatterbox")
        if not all([args.chatterbox_source, args.perth_source, args.s3tokenizer_source]):
            raise SystemExit("Chatterbox requires all three offline source paths")
        backend = ChatterboxBackend(
            model_path=args.model_path,
            voice_references=voice_references,
            default_voice=default_voice,
            chatterbox_source=args.chatterbox_source,
            perth_source=args.perth_source,
            s3tokenizer_source=args.s3tokenizer_source,
            public_voices=public_voices,
            voice_generation_settings=voice_generation_settings,
            model_id=args.model_id or "chatterbox",
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
        request_timeout_ms=args.request_timeout_ms,
    )
    serve(app, host=args.host, port=args.port, threads=args.max_queued_requests + 4,
          clear_untrusted_proxy_headers=True)


if __name__ == "__main__":
    main()
