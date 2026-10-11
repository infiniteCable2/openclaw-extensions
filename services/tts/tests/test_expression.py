from __future__ import annotations

import struct

import pytest

from openclaw_local_tts.app import create_app
from openclaw_local_tts.expression import KITTEN_EXPRESSION_CAPABILITIES, prepare_expression_segments
from openclaw_local_tts.types import RenderedPcm


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
    assert client.post("/v1/audio/speech", json=body(expression=plan())).status_code == 200
    first = list(backend.calls)
    backend.calls.clear()
    response = client.post("/v1/audio/speech/stream", json=body(expression=plan()))
    assert response.status_code == 200
    frames = response.data
    assert frames[-4:] == b"\0\0\0\0"
    assert struct.unpack(">I", frames[:4])[0] > 0
    assert backend.calls == first
    assert first == [("[joyful] Wir freuen uns <laugh> (((sehr))).", True)]


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
    response = client.post("/v1/audio/speech", json=body(expression=expression))
    assert response.status_code == 400
    assert backend.calls == []


def test_unsupported_backend_does_not_silently_ignore_expression():
    backend = Backend()
    backend.expression_capabilities = None
    client = create_app(backend, Encoder()).test_client()
    assert client.post("/v1/audio/speech", json=body(expression=plan())).status_code == 400
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
