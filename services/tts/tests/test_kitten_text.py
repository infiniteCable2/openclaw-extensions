import pytest

from openclaw_local_tts.kitten_text import prepare_kitten_text


@pytest.mark.parametrize(("text", "expected"), [
    ("Hallo🙂Welt!", "Hallo Welt!"),
    ("Gut gemacht! 😊✨", "Gut gemacht!"),
    ("👩🏽‍💻 Familie 👨‍👩‍👧‍👦 🇩🇪", "Familie"),
    ("1️⃣ #️⃣ *️⃣", ""),
    ("1, 2 und 3; 12,50 €; # *", "1, 2 und 3; 12,50 €; # *"),
    ("Äpfel, Öl, Straße; e\u0301; 中文; العربية", "Äpfel, Öl, Straße; e\u0301; 中文; العربية"),
    ("© 2026 ® ™", "© 2026 ® ™"),
    ("[joyful] Hallo 😊 <laugh> (((Welt)))!", "[joyful] Hallo <laugh> (((Welt)))!"),
    ("[joyful] 😊!", ""),
    ("[joyful] 😊 <laugh>", "[joyful] <laugh>"),
    ("<la🙂ugh>", "<la ugh>"),
    ("😊\n\nZweiter Absatz.", "Zweiter Absatz."),
    ("A.\n\nB. 😊", "A.\n\nB."),
    ("☺️ ❤️ 🏳️‍🌈 👍🏽", ""),
    ("\ufe0f\u200d", ""),
])
def test_cleanup(text, expected):
    assert prepare_kitten_text(text) == expected
    assert prepare_kitten_text(expected) == expected
