"""Offline stress matrix for the actual APM -> Silero VAD -> optional CUDA STT chain.

Input is a locally synthesized 16-kHz mono PCM16 voice WAV. No media or
transcript is logged or retained; only bounded numeric observations are printed.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from openclaw_local_stt.speech_apm import SAMPLE_RATE, create_speech_processor  # noqa: E402

FRAME_SAMPLES = SAMPLE_RATE // 50
MAX_VOICE_SECONDS = 20
MAX_DIRECT_SECONDS = 60
PROFILES = ("white", "road", "wash", "impacts")


def read_voice(path: Path, *, max_seconds: int = MAX_VOICE_SECONDS) -> np.ndarray:
    with wave.open(str(path), "rb") as source:
        if (
            source.getnchannels() != 1
            or source.getsampwidth() != 2
            or source.getframerate() != SAMPLE_RATE
            or not 0 < source.getnframes() <= SAMPLE_RATE * max_seconds
        ):
            raise ValueError(f"voice WAV must be 16-kHz mono PCM16 and at most {max_seconds} seconds")
        audio = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2")
    if audio.size == 0 or not np.any(audio):
        raise ValueError("voice WAV must contain nonzero speech samples")
    return audio.astype(np.float32) / 32768.0


def rms(audio: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))


def noise(profile: str, samples: int) -> np.ndarray:
    """Deterministic broad-band, slowly varying, and impulse-like stressors."""
    rng = np.random.default_rng(0x5A17 + PROFILES.index(profile))
    white = rng.standard_normal(samples).astype(np.float32)
    if profile == "white":
        result = white
    elif profile == "road":
        # A low-pass rolling component plus engine hum, with passing-traffic swell.
        low = np.convolve(white, np.ones(80, dtype=np.float32) / 80, mode="same")
        t = np.arange(samples, dtype=np.float32) / SAMPLE_RATE
        swell = 0.55 + 0.45 * np.square(np.sin(2 * np.pi * 0.15 * t))
        result = (low + 0.07 * np.sin(2 * np.pi * 95 * t)) * swell
    elif profile == "wash":
        # Spraying broadband hiss with a moving envelope and a low pump tone.
        t = np.arange(samples, dtype=np.float32) / SAMPLE_RATE
        hiss = white - np.convolve(white, np.ones(12, dtype=np.float32) / 12, mode="same")
        result = hiss * (0.3 + 0.7 * np.square(np.sin(2 * np.pi * 0.7 * t)))
        result += 0.15 * np.sin(2 * np.pi * 120 * t)
    else:
        result = white * 0.15
        for start in range(SAMPLE_RATE // 3, samples, SAMPLE_RATE // 2):
            length = min(1_600, samples - start)
            decay = np.exp(-np.arange(length, dtype=np.float32) / 240)
            result[start : start + length] += 4 * decay * rng.choice((-1.0, 1.0))
    level = rms(result)
    if level <= 0 or not math.isfinite(level):
        raise ValueError("noise generator produced an invalid level")
    return np.asarray(result / level, dtype=np.float32)


def enhance(audio: np.ndarray) -> tuple[np.ndarray, float, float, float, float]:
    processor = create_speech_processor()
    padded = np.pad(audio, (0, (-audio.size) % FRAME_SAMPLES))
    output = np.empty_like(padded)
    probabilities: list[float] = []
    gains: list[float] = []
    for start in range(0, padded.size, FRAME_SAMPLES):
        frame = processor.process(padded[start : start + FRAME_SAMPLES])
        if frame.shape != (FRAME_SAMPLES,) or not np.isfinite(frame).all():
            raise RuntimeError("APM returned invalid audio")
        output[start : start + FRAME_SAMPLES] = frame
        probability = float(processor.speech_probability)
        if not 0 <= probability <= 1 or not math.isfinite(probability):
            raise RuntimeError("APM returned invalid speech evidence")
        probabilities.append(probability)
        gain = float(processor.gain_db)
        if not math.isfinite(gain):
            raise RuntimeError("APM returned invalid gain evidence")
        gains.append(gain)
    return (
        output[: audio.size],
        float(np.mean(probabilities)),
        float(max(probabilities)),
        float(np.mean(gains)),
        float(max(gains)),
    )


def word_error_rate(expected: str, actual: str) -> float:
    reference = re.findall(r"\w+", expected.casefold())
    hypothesis = re.findall(r"\w+", actual.casefold())
    previous = list(range(len(hypothesis) + 1))
    for index, word in enumerate(reference, 1):
        current = [index]
        for offset, candidate in enumerate(hypothesis, 1):
            current.append(min(
                current[-1] + 1,
                previous[offset] + 1,
                previous[offset - 1] + (word != candidate),
            ))
        previous = current
    return previous[-1] / max(1, len(reference))


def transcribe_local(audio: np.ndarray, backend) -> str:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    with tempfile.TemporaryDirectory(prefix="openclaw-noise-matrix-") as directory:
        path = Path(directory) / "case.wav"
        with wave.open(str(path), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(SAMPLE_RATE)
            target.writeframes(pcm.tobytes())
        return backend.transcribe(path, language="de", prompt=None)


def evaluate(audio: np.ndarray, *, backend=None, expected: str | None = None) -> dict[str, float | None]:
    from faster_whisper.vad import get_speech_timestamps

    enhanced, probability_mean, probability_peak, gain_mean, gain_peak = enhance(audio)
    timestamps = get_speech_timestamps(enhanced, sampling_rate=SAMPLE_RATE)
    result: dict[str, float | None] = {
        "inputRms": round(rms(audio), 5),
        "enhancedRms": round(rms(enhanced), 5),
        "inputClipPercent": round(float(np.mean(np.abs(audio) >= 0.98)) * 100, 3),
        "enhancedClipPercent": round(float(np.mean(np.abs(enhanced) >= 0.98)) * 100, 3),
        "speechProbabilityMean": round(probability_mean, 3),
        "speechProbabilityPeak": round(probability_peak, 3),
        "gainDbMean": round(gain_mean, 3),
        "gainDbPeak": round(gain_peak, 3),
        "vadSpeechMs": round(sum(
            chunk["end"] - chunk["start"] for chunk in timestamps
        ) * 1_000 / SAMPLE_RATE),
        "wer": None,
    }
    if backend is not None and expected is not None:
        result["wer"] = round(word_error_rate(expected, transcribe_local(enhanced, backend)), 3)
    return result


def evaluate_raw(audio: np.ndarray, *, backend=None, expected: str | None = None) -> dict[str, float | None]:
    """Paired control: identical samples and VAD/STT, without the APM pass."""
    from faster_whisper.vad import get_speech_timestamps

    timestamps = get_speech_timestamps(audio, sampling_rate=SAMPLE_RATE)
    result: dict[str, float | None] = {
        "rms": round(rms(audio), 5),
        "clipPercent": round(float(np.mean(np.abs(audio) >= 0.98)) * 100, 3),
        "vadSpeechMs": round(sum(
            chunk["end"] - chunk["start"] for chunk in timestamps
        ) * 1_000 / SAMPLE_RATE),
        "wer": None,
    }
    if backend is not None and expected is not None:
        result["wer"] = round(word_error_rate(expected, transcribe_local(audio, backend)), 3)
    return result


def parse_levels(value: str, *, minimum: float, maximum: float) -> list[float]:
    levels = [float(item) for item in value.split(",")]
    if not levels or len(levels) > 12 or any(
        not math.isfinite(level) or level < minimum or level > maximum for level in levels
    ):
        raise ValueError("invalid level matrix")
    return levels


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("voice_wav", type=Path)
    parser.add_argument("--snr-db", default="-20,-10,0,10,20")
    parser.add_argument("--voice-dbfs", default="-40,-26,-12")
    parser.add_argument("--model-path", type=Path, help="optional local CUDA model directory")
    parser.add_argument("--expected", help="expected words; required with --model-path")
    parser.add_argument("--paired", action="store_true", help="report raw and APM results for identical inputs")
    parser.add_argument("--direct", action="store_true", help="compare the supplied WAV as-is, without synthetic noise")
    args = parser.parse_args()
    if bool(args.model_path) != bool(args.expected):
        parser.error("--model-path and --expected must be supplied together")
    voice = read_voice(args.voice_wav, max_seconds=MAX_DIRECT_SECONDS if args.direct else MAX_VOICE_SECONDS)
    backend = None
    if args.model_path:
        from openclaw_local_stt.backend import FasterWhisperBackend

        backend = FasterWhisperBackend(model_path=args.model_path)
    if args.direct:
        print(json.dumps({
            "cases": [{
                "profile": "direct",
                "raw": evaluate_raw(voice, backend=backend, expected=args.expected),
                "apm": evaluate(voice, backend=backend, expected=args.expected),
            }],
            "decoderTested": backend is not None,
        }, separators=(",", ":")))
        return
    snrs = parse_levels(args.snr_db, minimum=-30, maximum=30)
    voice_levels = parse_levels(args.voice_dbfs, minimum=-60, maximum=-3)
    if len(snrs) * len(voice_levels) * len(PROFILES) > 200:
        parser.error("matrix exceeds 200 cases")
    voice = np.pad(voice, (SAMPLE_RATE // 2, SAMPLE_RATE // 2))
    voice_rms = rms(voice)
    rows = []
    for profile in PROFILES:
        base_noise = noise(profile, voice.size)
        for voice_dbfs in voice_levels:
            target_voice_rms = 10 ** (voice_dbfs / 20)
            scaled_voice = voice * (target_voice_rms / voice_rms)
            for snr_db in snrs:
                noise_rms = target_voice_rms / 10 ** (snr_db / 20)
                mixed = np.clip(scaled_voice + base_noise * noise_rms, -1, 1)
                noise_only = np.clip(base_noise * noise_rms, -1, 1)
                control = evaluate(noise_only)
                apm = evaluate(mixed, backend=backend, expected=args.expected)
                row = {
                    "profile": profile,
                    "voiceDbfs": voice_dbfs,
                    "snrDb": snr_db,
                    "noiseOnlyVadSpeechMs": control["vadSpeechMs"],
                    "noiseOnlyProbabilityPeak": control["speechProbabilityPeak"],
                    "noiseOnlyGainDbPeak": control["gainDbPeak"],
                }
                if args.paired:
                    row.update({
                        "noiseOnlyRawVadSpeechMs": evaluate_raw(noise_only)["vadSpeechMs"],
                        "raw": evaluate_raw(mixed, backend=backend, expected=args.expected),
                        "apm": apm,
                    })
                else:
                    row.update(apm)
                rows.append(row)
    print(json.dumps({"cases": rows, "decoderTested": backend is not None}, separators=(",", ":")))


if __name__ == "__main__":
    main()
