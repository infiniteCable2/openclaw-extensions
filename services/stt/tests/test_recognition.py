from __future__ import annotations

from openclaw_local_stt.recognition import RecognitionEvidence


def test_evidence_rejects_invalid_or_unbounded_backend_metrics():
    evidence = RecognitionEvidence()
    evidence.add_segment()
    for value in (True, float("nan"), float("inf"), -1, 101, 10**1000, "PRIVATE_TRANSCRIPT"):
        evidence.add_signal("backend.probability", value, minimum=0, maximum=100)
    evidence.add_signal("PRIVATE_TRANSCRIPT\n", 0.5, minimum=0, maximum=1)
    evidence.add_signal("backend.probability", 0.25, minimum=0, maximum=1)
    evidence.add_signal("backend.probability", 0.75, minimum=0, maximum=1)
    result = evidence.result(audio_duration_ms=None, speech_duration_ms=None)
    assert result == {
        "audioDurationMs": None,
        "speechDurationMs": None,
        "segmentCount": 1,
        "signals": [{"name": "backend.probability", "mean": 0.5, "samples": 2}],
    }


def test_evidence_limits_signal_cardinality():
    evidence = RecognitionEvidence()
    for index in range(12):
        evidence.add_signal(f"backend.signal{index}", index, minimum=0, maximum=12)
    assert len(evidence.result(audio_duration_ms=10, speech_duration_ms=5)["signals"]) == 8
