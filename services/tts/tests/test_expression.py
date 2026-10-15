from __future__ import annotations

import struct

import pytest

from openclaw_local_tts.app import create_app
from openclaw_local_tts.expression import KITTEN_EXPRESSION_CAPABILITIES, prepare_expression_segments
from openclaw_local_tts.types import RenderedPcm
from openclaw_local_tts.speech_segments import SpeechSegment
from openclaw_local_tts.speech_profile import KITTEN_SPEECH_PROFILE


class Backend:
    model_id = "synthetic"
    default_voice = "voice_a"
    voice_ids = frozenset({"voice_a"})
    public_voices = ({"id": "voice_a", "name": "Example voice"},)
    requested_backend = observed_backend = "cuda"
    sample_rate = 24_000
    expression_capabilities = KITTEN_EXPRESSION_CAPABILITIES

    def __init__(self):
        self.calls = []

    def synthesize_segments(self, texts, *, voice_id):
        for text in texts:
            self.calls.append((text, False))
            yield RenderedPcm(b"\x01\x00" * 240, self.sample_rate)

    def synthesize_expressive_segments(self, texts, *, voice_id):
        for text in texts:
            self.calls.append((text, True))
            yield RenderedPcm(b"\x01\x00" * 240, self.sample_rate)


class Encoder:
    def encode(self, rendered, **_kwargs):
        return rendered.data


def body(**kwargs):
    return dict(input="Wir freuen uns sehr.", model="synthetic", voice="voice_a", response_format="pcm", **kwargs)


def plan():
    return {"emotion": "joyful", "parts": [
        {"text": "Wir freuen uns "}, {"event": "laugh"}, {"text": "sehr", "emphasis": True}, {"text": "."},
    ]}


def expression_headers(client):
    return {"X-OpenClaw-Service-Generation": client.get("/ready").headers["X-OpenClaw-Service-Generation"]}


def test_structured_plan_keeps_visible_text_exact_and_controls_atomic():
    source = "Ein längerer Testsatz mit unterschiedlichen Wörtern. " * 10 + "Ende."
    expression = {"emotion": "tender", "parts": [{"text": source}, {"event": "sigh"}]}
    segments = prepare_expression_segments(source, expression, KITTEN_EXPRESSION_CAPABILITIES)
    assert len(segments) > 1
    assert all(segment.text.startswith("[tender] ") for segment in segments)
    assert sum(segment.text.count("<sigh>") for segment in segments) == 1
    assert source == expression["parts"][0]["text"]
    assert all("OCEXPRESSIONTOKEN" not in segment.text for segment in segments)


def test_synthesis_and_stream_use_same_opt_in_plan():
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    headers = expression_headers(client)
    assert client.post("/v1/audio/speech", json=body(expression=plan()), headers=headers).status_code == 200
    first = list(backend.calls)
    backend.calls.clear()
    response = client.post("/v1/audio/speech/stream", json=body(expression=plan()), headers=headers)
    assert response.status_code == 200
    frames = response.data
    assert frames[-4:] == b"\0\0\0\0"
    assert struct.unpack(">I", frames[:4])[0] > 0
    assert backend.calls == first
    assert first == [("[joyful] Wir freuen uns <laugh> (((sehr))).", True)]


def test_interleaved_stream_preserves_its_expression_mode_and_order():
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    headers = expression_headers(client)
    text = "Erster Satz. Zweiter Satz."
    request = {**body(), "input": text, "expression": {"emotion": "joyful", "parts": [{"text": text}]},
               "segmentation": {"schema_version": 1, "segments": [
                   {"text": "Erster Satz.", "pauseMs": 180}, {"text": "Zweiter Satz.", "pauseMs": 0},
               ]}}
    response = client.post("/v1/audio/speech/stream", json=request, headers=headers, buffered=False)
    try:
        assert len(backend.calls) == 1
        assert client.post("/v1/audio/speech", json=body()).status_code == 200
        assert response.data[-4:] == b"\0\0\0\0"
    finally:
        response.close()
    assert backend.calls == [
        ("[joyful] Erster Satz.", True),
        ("Wir freuen uns sehr.", False),
        ("[joyful] Zweiter Satz.", True),
    ]


def test_capabilities_do_not_advertise_whisper_or_private_references():
    capabilities = create_app(Backend(), Encoder()).test_client().get("/v1/capabilities").get_json()
    assert capabilities["expression"]["whisper"] is False
    assert "reference" not in str(capabilities)


@pytest.mark.parametrize("expression", [
    {"emotion": "whispering", "parts": [{"text": "Wir freuen uns sehr."}]},
    {"parts": [{"event": "whisper"}, {"text": "Wir freuen uns sehr."}]},
    {"parts": [{"text": "Andere Antwort."}]},
    {"parts": [{"text": "Wir freuen uns sehr.", "emphasis": 1}]},
    {"parts": [{"text": "Wir freuen uns sehr.", "unexpected": True}]},
    None,
])
def test_invalid_plan_is_rejected_before_inference(expression):
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    response = client.post("/v1/audio/speech", json=body(expression=expression), headers=expression_headers(client))
    assert response.status_code == 400
    assert backend.calls == []


def test_unsupported_backend_does_not_silently_ignore_expression():
    backend = Backend()
    backend.expression_capabilities = None
    client = create_app(backend, Encoder()).test_client()
    assert client.post("/v1/audio/speech", json=body(expression=plan()), headers=expression_headers(client)).status_code == 400
    assert client.post("/v1/audio/speech", json=body()).status_code == 200
    assert backend.calls == [("Wir freuen uns sehr.", False)]


@pytest.mark.parametrize("text", ["[[tts:voice=x]] Hallo.", "[joyful] Hallo.", "Hallo <laugh>."])
def test_native_or_backend_tags_are_not_a_second_command_dsl(text):
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    request = body()
    request["input"] = text
    assert client.post("/v1/audio/speech", json=request).status_code == 400
    assert backend.calls == []


@pytest.mark.parametrize("endpoint", ["/v1/audio/speech", "/v1/audio/speech/stream"])
@pytest.mark.parametrize("pieces", [
    ["[whis", "per] Hello."],
    ["<lau", "gh> Hello."],
    ["((", "(Hello.", "))", ")"],
    ["[", "[tts:voice=x]] Hello."],
    ["OCEXPRESSION", "TOKEN Hello."],
])
def test_split_raw_controls_are_rejected_before_inference(endpoint, pieces):
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    request = body(expression={"parts": [{"text": piece} for piece in pieces]})
    request["input"] = "".join(pieces)
    response = client.post(endpoint, json=request, headers=expression_headers(client))
    assert response.status_code == 400
    assert backend.calls == []


def test_plain_citations_and_comparisons_are_preserved():
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    request = body()
    request["input"] = "Siehe [3]; x < 5."
    assert client.post("/v1/audio/speech", json=request).status_code == 200
    assert backend.calls == [("Siehe [3]; x < 5.", False)]


@pytest.mark.parametrize("parts", [
    [{"text": "Ha"}, {"event": "laugh"}, {"text": "llo."}],
    [{"text": "Ha"}, {"text": "llo", "emphasis": True}, {"text": "."}],
    [{"text": "Ha", "emphasis": True}, {"text": "llo."}],
])
def test_controls_cannot_change_word_boundaries(parts):
    with pytest.raises(ValueError, match="split a word"):
        prepare_expression_segments("Hallo.", {"parts": parts}, KITTEN_EXPRESSION_CAPABILITIES)


@pytest.mark.parametrize("endpoint", ["/v1/audio/speech", "/v1/audio/speech/stream"])
def test_worker_replacement_rejects_stale_or_missing_expression_admission(endpoint):
    first = create_app(Backend(), Encoder()).test_client()
    backend = Backend()
    replacement = create_app(backend, Encoder()).test_client()
    old = expression_headers(first)
    ready = replacement.get("/ready")
    capabilities = replacement.get("/v1/capabilities")
    assert ready.get_json()["generation"] == capabilities.get_json()["generation"]
    assert ready.headers["X-OpenClaw-Service-Generation"] != old["X-OpenClaw-Service-Generation"]
    for headers in ({}, old):
        response = replacement.post(endpoint, json=body(expression=plan()), headers=headers)
        assert response.status_code == 409
        assert response.get_json()["error"]["code"] == "generation_conflict"
    assert backend.calls == []


def test_prepared_expression_keeps_events_once_and_emphasis_atomic():
    source = "Erster Satz. Zweiter wichtiger Satz."
    expression = {"emotion": "tender", "parts": [
        {"text": "Erster Satz."}, {"event": "sigh"}, {"text": " Zweiter "},
        {"text": "wichtiger", "emphasis": True}, {"text": " Satz."},
    ]}
    prepared = [SpeechSegment("Erster Satz.", 120), SpeechSegment("Zweiter wichtiger Satz.", 0)]
    result = prepare_expression_segments(source, expression, KITTEN_EXPRESSION_CAPABILITIES, prepared_segments=prepared)
    assert [unit.text for unit in result] == [
        "[tender] Erster Satz. <sigh>", "[tender] Zweiter (((wichtiger))) Satz.",
    ]
    assert [unit.pause_after_ms for unit in result] == [120, 0]
    assert "".join(part.get("text", "") for part in expression["parts"]) == source


def test_prepared_expression_does_not_silently_move_emphasis_across_segments():
    with pytest.raises(ValueError, match="emphasis span"):
        prepare_expression_segments("Hallo Welt.", {"parts": [{"text": "Hallo Welt", "emphasis": True}, {"text": "."}]},
            KITTEN_EXPRESSION_CAPABILITIES,
            prepared_segments=[SpeechSegment("Hallo", 0), SpeechSegment("Welt.", 0)])


def test_standalone_kitten_packing_counts_restored_emphasis_not_placeholders():
    parts = []
    for paragraph in range(2):
        for word in range(3):
            parts.append({"text": "a" * 80, "emphasis": True})
            if word < 2:
                parts.append({"text": " "})
        parts.append({"text": ".\n\n" if paragraph == 0 else "."})
    text = "".join(part["text"] for part in parts)
    segments = prepare_expression_segments(text, {"parts": parts}, KITTEN_EXPRESSION_CAPABILITIES,
                                          profile=KITTEN_SPEECH_PROFILE)
    assert len(segments) == 2
    assert all(len(segment.text) <= 300 for segment in segments)
    assert sum(segment.text.count("(((") for segment in segments) == 6


@pytest.mark.parametrize("prepared", [False, True])
def test_emotion_changes_repeat_per_sentence_in_one_generation_unit(prepared):
    source = "Ich bin hier. Du hörst mich. Es ist still. Wir warten. Jetzt geht es weiter."
    expression = {"emotion": "joyful", "parts": [
        {"text": "Ich bin hier. Du hörst mich. "},
        {"text": "Es ist still. ", "emotion": "sad"},
        {"text": "Wir warten. "},
        {"text": "Jetzt geht es weiter.", "emotion": "joyful"},
    ]}
    result = prepare_expression_segments(
        source, expression, KITTEN_EXPRESSION_CAPABILITIES, profile=KITTEN_SPEECH_PROFILE,
        prepared_segments=[SpeechSegment(source, 180)] if prepared else None,
    )
    assert len(result) == 1
    assert result[0].text == (
        "[joyful] Ich bin hier. [joyful] Du hörst mich. [sad] Es ist still. "
        "[sad] Wir warten. [joyful] Jetzt geht es weiter."
    )
    if prepared:
        assert result[0].pause_after_ms == 180
    assert "".join(part["text"] for part in expression["parts"]) == source


def test_prepared_fragment_keeps_emotion_and_events_once_without_rechunking():
    source = "Erster Satz. Ein langer weiterer Satz endet hier."
    expression = {"parts": [
        {"text": "Erster Satz.", "emotion": "sad"}, {"event": "sigh"},
        {"text": " Ein langer weiterer Satz endet hier.", "emotion": "joyful"},
    ]}
    prepared = [SpeechSegment("Erster Satz.", 180), SpeechSegment("Ein langer", 60),
                SpeechSegment("weiterer Satz endet hier.", 0)]
    result = prepare_expression_segments(source, expression, KITTEN_EXPRESSION_CAPABILITIES,
                                         prepared_segments=prepared)
    assert [part.text for part in result] == [
        "[sad] Erster Satz. <sigh>", "[joyful] Ein langer", "[joyful] weiterer Satz endet hier.",
    ]
    assert [part.pause_after_ms for part in result] == [180, 60, 0]


@pytest.mark.parametrize("prepared", [False, True])
def test_many_short_sentences_do_not_exhaust_plain_text_budget_with_emotion_tags(prepared):
    source = " ".join(["Ja."] * 32)
    expression = {"emotion": "contemplative", "parts": [{"text": source}]}
    result = prepare_expression_segments(
        source, expression, KITTEN_EXPRESSION_CAPABILITIES, profile=KITTEN_SPEECH_PROFILE,
        prepared_segments=[SpeechSegment(source, 0)] if prepared else None,
    )
    assert len(result) == 1
    assert result[0].text == " ".join(["[contemplative] Ja."] * 32)


def test_citation_at_fragment_start_does_not_suppress_active_emotion():
    source = "Wir lesen [123] weiter."
    result = prepare_expression_segments(
        source, {"emotion": "joyful", "parts": [{"text": source}]}, KITTEN_EXPRESSION_CAPABILITIES,
        prepared_segments=[SpeechSegment("Wir lesen", 60), SpeechSegment("[123] weiter.", 0)],
    )
    assert [part.text for part in result] == ["[joyful] Wir lesen", "[joyful] [123] weiter."]


@pytest.mark.parametrize("prepared", [False, True])
def test_sentence_emotions_respect_abbreviations_numbers_and_emphasis(prepared):
    source = "Dr. Weber kommt um 12.30 Uhr. Wirklich. Ganz sicher!"
    expression = {"emotion": "tender", "parts": [
        {"text": "Dr. Weber kommt um 12.30 Uhr. "},
        {"text": "Wirklich. Ganz sicher!", "emphasis": True},
    ]}
    result = prepare_expression_segments(
        source, expression, KITTEN_EXPRESSION_CAPABILITIES, profile=KITTEN_SPEECH_PROFILE,
        prepared_segments=[SpeechSegment(source, 0)] if prepared else None,
    )
    assert len(result) == 1
    assert result[0].text == (
        "[tender] Dr. Weber kommt um 12.30 Uhr. "
        "[tender] (((Wirklich.))) [tender] (((Ganz sicher!)))"
    )


@pytest.mark.parametrize("emotion", [None, "[joyful]", "whisper", 1])
def test_invalid_part_emotion_is_rejected_before_inference(emotion):
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    request = body(expression={"parts": [{"text": "Wir freuen uns sehr.", "emotion": emotion}]})
    assert client.post("/v1/audio/speech", json=request, headers=expression_headers(client)).status_code == 400
    assert backend.calls == []


@pytest.mark.parametrize("endpoint", ["/v1/audio/speech", "/v1/audio/speech/stream"])
def test_multi_emotion_request_reaches_backend_once_with_clean_native_plan(endpoint):
    backend = Backend()
    client = create_app(backend, Encoder()).test_client()
    source = "Ich bin hier. Du hörst mich. Es ist still. Wir warten."
    request = body(expression={"emotion": "joyful", "parts": [
        {"text": "Ich bin hier. Du hörst mich. "},
        {"text": "Es ist still. Wir warten.", "emotion": "sad"},
    ]}, segmentation={"schema_version": 1, "segments": [{"text": source, "pauseMs": 0}]})
    request["input"] = source
    response = client.post(endpoint, json=request, headers=expression_headers(client))
    assert response.status_code == 200
    assert response.data
    assert backend.calls == [(
        "[joyful] Ich bin hier. [joyful] Du hörst mich. [sad] Es ist still. [sad] Wir warten.", True,
    )]
