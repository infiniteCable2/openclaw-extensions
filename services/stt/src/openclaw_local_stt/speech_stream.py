"""Bounded, per-call WebRTC APM stream for agent-directed live speech.

The transport is fixed-size 20 ms mono PCM16 frames at 16 kHz. It deliberately
has no relay mode: callers must opt in before creating this process. Without a
synchronized far-end signal, AEC must remain disabled.
"""

from __future__ import annotations

import sys

from .speech_apm import SAMPLE_RATE, create_speech_processor

FRAME_SAMPLES = SAMPLE_RATE // 50
FRAME_BYTES = FRAME_SAMPLES * 2
# Fixed ordered float32 metadata. APM3 requires the matching adapter; an older
# worker fails its readiness handshake rather than silently misframing audio.
CONTROL_FIELDS = ("cleanRms", "nativeGainDb", "minimumCeilingDb", "maximumCeilingDb",
                  "speechFrames", "uncertainFrames", "nonspeechFrames", "holdFrames",
                  "attenuateFrames", "recoverFrames", "clippedFrames", "mutedFrames")
METADATA_BYTES = (2 + len(CONTROL_FIELDS)) * 4


def main() -> int:
    import numpy as np
    processor = create_speech_processor()
    source = sys.stdin.buffer
    sink = sys.stdout.buffer
    sink.write(b"APM3")
    sink.flush()
    while True:
        frame = source.read(FRAME_BYTES)
        if not frame:
            return 0
        if len(frame) != FRAME_BYTES:
            return 2
        samples = np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0
        output = processor.process(samples)
        if output.shape != (FRAME_SAMPLES,) or not np.isfinite(output).all():
            return 3
        encoded = (np.clip(output, -1.0, 1.0) * 32767.0).astype("<i2")
        probability = float(processor.speech_probability)
        gain_db = float(processor.gain_db)
        if not np.isfinite(probability) or not 0.0 <= probability <= 1.0 or not np.isfinite(gain_db):
            return 3
        sink.write(encoded.tobytes())
        metadata = [probability, gain_db, *(processor.control[name] for name in CONTROL_FIELDS)]
        if not np.isfinite(metadata).all():
            return 3
        sink.write(np.asarray(metadata, dtype="<f4").tobytes())
        sink.flush()


if __name__ == "__main__":
    raise SystemExit(main())
