"""Offline 20-ms trace through the real speech processor; no STT model or media output.

Use a private mono 16-kHz PCM16 voice WAV only as an in-memory excitation.
The emitted JSON lines contain numeric measurements and synthetic phase labels.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from openclaw_local_stt.speech_apm import SAMPLE_RATE, SpeechControlConfig, create_speech_processor  # noqa: E402

FRAME = SAMPLE_RATE // 50
PHASES = (
    ("quiet_background", 4, 0.003, 0.0),
    ("quiet_voice", 4, 0.003, 0.05),
    ("moderate_background", 10, 0.03, 0.0),
    ("moderate_voice", 4, 0.03, 0.05),
    ("loud_background_pre", 4, 0.12, 0.0),
    ("quiet_voice_before_pause", 4, 0.12, 0.05),
    ("loud_background_pause", 90, 0.12, 0.0),
    ("quiet_voice_after_pause", 4, 0.12, 0.05),
    ("loud_background_short", 4, 0.12, 0.0),
    ("loud_voice_after_pause", 4, 0.12, 0.12),
    ("moderate_background_recovery", 4, 0.03, 0.0),
    ("moderate_voice_recovery", 4, 0.03, 0.05),
)


def energy(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(values, dtype=np.float64))))


def read_wave(path: Path, *, maximum_seconds: int) -> np.ndarray:
    with wave.open(str(path), "rb") as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError("seed must be mono 16-kHz PCM16 WAV")
        if not 0 < source.getnframes() <= SAMPLE_RATE * maximum_seconds:
            raise ValueError("seed duration is outside its bound")
        raw = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32)
    return raw / 32768.0


def voice_excerpt(path: Path) -> np.ndarray:
    voice = read_wave(path, maximum_seconds=60)
    if voice.size < SAMPLE_RATE * 4:
        raise ValueError("voice seed must contain at least four seconds")
    window = SAMPLE_RATE * 4
    starts = range(0, voice.size - window + 1, SAMPLE_RATE)
    start = max(starts, key=lambda position: energy(voice[position:position + window]))
    excerpt = voice[start:start + window]
    level = energy(excerpt)
    if not math.isfinite(level) or level < 0.001:
        raise ValueError("voice seed has insufficient energy")
    return np.asarray(excerpt / level, dtype=np.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", type=Path, required=True)
    parser.add_argument("--noise", type=Path,
                        help="private real background recording, repeated after its end")
    parser.add_argument("--noise-limit-dbfs", type=float, default=-50)
    parser.add_argument("--gain-rate-db-per-second", type=float, default=6)
    parser.add_argument("--summary", action="store_true")
    args = parser.parse_args()
    voice = voice_excerpt(args.voice)
    processor = create_speech_processor(SpeechControlConfig(
        max_output_noise_level_dbfs=args.noise_limit_dbfs,
        max_gain_change_db_per_second=args.gain_rate_db_per_second,
    ))
    total = sum(seconds for _, seconds, _, _ in PHASES) * SAMPLE_RATE
    if args.noise:
        recorded_noise = read_wave(args.noise, maximum_seconds=120)
        level = energy(recorded_noise)
        if not math.isfinite(level) or level < 0.0001:
            raise ValueError("background seed has insufficient energy")
        background = np.tile(recorded_noise / level,
                             math.ceil(total / recorded_noise.size))[:total]
    else:
        from offline_noise_matrix import noise
        background = noise("wash", total)
    position = 0
    summaries: dict[str, list[dict[str, float]]] = {}
    for phase, seconds, noise_rms, voice_rms in PHASES:
        samples = seconds * SAMPLE_RATE
        for offset in range(0, samples, FRAME):
            index = position + offset
            # The two quiet-voice stress windows use identical voice *and*
            # background samples. Their only deliberate difference is the
            # regulator history across the long noisy pause.
            matched = phase in ("quiet_voice_before_pause", "quiet_voice_after_pause")
            noise_offset = offset if matched else index
            mixed = background[noise_offset:noise_offset + FRAME] * np.float32(noise_rms)
            if voice_rms:
                mixed = mixed + voice[offset % voice.size:(offset % voice.size) + FRAME] * np.float32(voice_rms)
            original = np.clip(mixed, -1, 1).astype(np.float32)
            enhanced = processor.process(original)
            control = processor.control
            record = {
                "tMs": index // FRAME * 20,
                "phase": phase,
                "originalRms": energy(original),
                "originalPeak": float(np.max(np.abs(original))),
                "enhancedRms": energy(enhanced),
                "speechProbability": float(processor.speech_probability),
                "gainDb": float(processor.gain_db),
                "cleanRms": control["cleanRms"],
                "clippedFrames": control["clippedFrames"],
            }
            if args.summary:
                summaries.setdefault(phase, []).append(record)
            else:
                print(json.dumps(record, allow_nan=False, separators=(",", ":")), flush=True)
        position += samples
    if args.summary:
        keys = ("originalRms", "enhancedRms", "speechProbability", "gainDb", "cleanRms")
        for phase, records in summaries.items():
            print(json.dumps({"phase": phase, **{
                key: round(sum(record[key] for record in records) / len(records), 5)
                for key in keys
            }}, separators=(",", ":")))


if __name__ == "__main__":
    main()
