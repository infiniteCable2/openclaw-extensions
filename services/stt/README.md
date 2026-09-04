# Local STT service

Standalone, bounded speech-to-text runtime. The initial extraction target is a
CUDA-backed Faster-Whisper worker with explicit model readiness and no implicit
CPU or cloud fallback.
