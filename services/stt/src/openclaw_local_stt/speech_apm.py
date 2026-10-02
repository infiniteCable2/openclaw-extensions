"""One WebRTC APM configuration for live and uploaded agent-directed speech."""

from __future__ import annotations


SAMPLE_RATE = 16_000


def create_speech_processor():
    from pywebrtc_audio import AudioProcessor

    return AudioProcessor(
        sample_rate=SAMPLE_RATE,
        noise_suppression=True,
        high_pass_filter=True,
        auto_gain_control=True,
        echo_cancellation=False,
        ns_level=1,
        agc_max_gain_db=12.0,
    )
