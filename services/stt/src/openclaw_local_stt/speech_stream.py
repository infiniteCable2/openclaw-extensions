"""Bounded, per-call WebRTC APM stream for agent-directed live speech.

The transport is fixed-size 20 ms mono PCM16 frames at 16 kHz. It deliberately
has no relay mode: callers must opt in before creating this process. Without a
synchronized far-end signal, AEC must remain disabled.
"""

from __future__ import annotations

import sys

FRAME_SAMPLES = 320
FRAME_BYTES = FRAME_SAMPLES * 2


def main() -> int:
    import numpy as np
    from pywebrtc_audio import AudioProcessor

    processor = AudioProcessor(
        sample_rate=16_000,
        noise_suppression=True,
        high_pass_filter=True,
        auto_gain_control=True,
        echo_cancellation=False,
        ns_level=1,
        agc_max_gain_db=12.0,
    )
    source = sys.stdin.buffer
    sink = sys.stdout.buffer
    sink.write(b"APM1")
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
        sink.write(encoded.tobytes())
        sink.flush()


if __name__ == "__main__":
    raise SystemExit(main())
