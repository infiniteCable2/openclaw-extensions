"""Local, model-free old/new APM replay. Emits numeric evidence only.

Pipe JSON lines to compare_speech_gate.mjs to exercise the real TS gate.
Recordings stay local; no audio, transcript, filename or path is printed.
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
from openclaw_local_stt.speech_apm import SAMPLE_RATE, SpeechControlConfig, create_speech_processor

FRAME = SAMPLE_RATE // 50


def rms(audio):
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))


def replay(audio, processor):
    frames = []
    output_energy = 0.0
    output_peak = 0.0
    for offset in range(0, len(audio), FRAME):
        original = audio[offset:offset + FRAME]
        padded = np.pad(original, (0, FRAME - len(original)))
        output = processor.process(padded)
        if output.shape != padded.shape or not np.isfinite(output).all():
            raise RuntimeError("invalid APM output")
        frames.append({
            "originalRms": rms(padded), "originalPeak": float(np.max(np.abs(padded))),
            "enhancedRms": rms(output), "speechProbability": float(processor.speech_probability),
            "gainDb": float(processor.gain_db),
        })
        output_energy += float(np.sum(np.square(output[:len(original)], dtype=np.float64)))
        output_peak = max(output_peak, float(np.max(np.abs(output[:len(original)]))))
    return {
        "frames": frames,
        "outputRmsDbfs": 10 * math.log10(max(output_energy / len(audio), 1e-12)),
        "outputPeakDbfs": 20 * math.log10(max(output_peak, 1e-6)),
        "maxGainDb": max(frame["gainDb"] for frame in frames),
        "minGainDb": min(frame["gainDb"] for frame in frames),
    }


def read_audio(path):
    with wave.open(str(path), "rb") as source:
        if (source.getnchannels() != 1 or source.getsampwidth() != 2 or
            source.getframerate() != SAMPLE_RATE or not 0 < source.getnframes() <= 60 * SAMPLE_RATE):
            raise ValueError("input must be mono 16-kHz PCM16 WAV, at most 60 seconds")
        return np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768


def main():
    from pywebrtc_audio import AudioProcessor
    from offline_noise_matrix import PROFILES, noise

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", default=[])
    parser.add_argument("--synthetic-noise", action="store_true")
    parser.add_argument("--level-transitions", action="store_true",
                        help="also replay quiet/loud/quiet phases without resetting processors")
    parser.add_argument("--slew-db-per-second", type=float, default=6.0)
    parser.add_argument("--headroom-db", type=float, default=8.0)
    parser.add_argument("--noise-limit-dbfs", type=float, default=-50.0)
    args = parser.parse_args()
    if not args.input and not args.synthetic_noise:
        parser.error("provide input or select synthetic noise")
    if len(args.input) > 32:
        parser.error("at most 32 recordings")
    settings = SpeechControlConfig(headroom_db=args.headroom_db,
                                   max_output_noise_level_dbfs=args.noise_limit_dbfs,
                                   max_gain_change_db_per_second=args.slew_db_per_second)
    cases = [(f"recording-{index + 1}", read_audio(path)) for index, path in enumerate(args.input)]
    if args.synthetic_noise:
        for profile in PROFILES:
            # Quiet -> loud -> quiet source changes exercise control recovery.
            samples = noise(profile, SAMPLE_RATE * 15)
            envelope = np.repeat(np.array([0.003, 0.06, 0.003], dtype=np.float32), SAMPLE_RATE * 5)
            cases.append((f"synthetic-{profile}", np.clip(samples * envelope, -1, 1)))
    for case, audio in cases:
        baseline = AudioProcessor(sample_rate=SAMPLE_RATE, noise_suppression=True,
                                  high_pass_filter=True, auto_gain_control=True,
                                  echo_cancellation=False, ns_level=1, agc_max_gain_db=12.0)
        print(json.dumps({
            "case": case, "durationMs": len(audio) / SAMPLE_RATE * 1000,
            "baseline": replay(audio, baseline), "candidate": replay(audio, create_speech_processor(settings)),
        }, allow_nan=False, separators=(",", ":")), flush=True)
        if args.level_transitions and case.startswith("recording-"):
            start = min(SAMPLE_RATE * 3, len(audio) // 4)
            excerpt = audio[start:start + SAMPLE_RATE * 6]
            peak = float(np.max(np.abs(excerpt)))
            if peak <= 0:
                continue
            excerpt = excerpt / peak
            baseline = AudioProcessor(sample_rate=SAMPLE_RATE, noise_suppression=True,
                                      high_pass_filter=True, auto_gain_control=True,
                                      echo_cancellation=False, ns_level=1, agc_max_gain_db=12.0)
            candidate = create_speech_processor(settings)
            for phase, scale in (("quiet", 0.05), ("loud", 0.98), ("quiet-again", 0.05)):
                samples = np.asarray(excerpt * scale, dtype=np.float32)
                print(json.dumps({
                    "case": f"{case}-{phase}", "durationMs": len(samples) / SAMPLE_RATE * 1000,
                    "sequence": f"{case}-level-transition",
                    "baseline": replay(samples, baseline), "candidate": replay(samples, candidate),
                }, allow_nan=False, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
