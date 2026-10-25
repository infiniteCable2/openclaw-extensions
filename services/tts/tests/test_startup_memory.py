from __future__ import annotations

from types import SimpleNamespace

import pytest

from openclaw_local_tts import startup_memory


@pytest.mark.parametrize("released", [0, 1])
def test_collect_then_trim_in_current_process(monkeypatch, released):
    calls = []

    class Trim:
        def __call__(self, pad):
            calls.append(("trim", pad))
            return released

    trim = Trim()
    monkeypatch.setattr(startup_memory.sys, "platform", "linux")
    monkeypatch.setattr(startup_memory.gc, "collect", lambda: calls.append("collect"))

    def library(name):
        calls.append(("library", name))
        return SimpleNamespace(malloc_trim=trim)

    monkeypatch.setattr(startup_memory.ctypes, "CDLL", library)
    startup_memory.release_startup_memory()
    assert calls == ["collect", ("library", None), ("trim", 0)]
    assert trim.argtypes == [startup_memory.ctypes.c_size_t]
    assert trim.restype == startup_memory.ctypes.c_int


def test_other_platform_collects_without_native_library(monkeypatch):
    calls = []
    monkeypatch.setattr(startup_memory.sys, "platform", "win32")
    monkeypatch.setattr(startup_memory.gc, "collect", lambda: calls.append("collect"))
    monkeypatch.setattr(startup_memory.ctypes, "CDLL", lambda _: pytest.fail("native library requested"))
    startup_memory.release_startup_memory()
    assert calls == ["collect"]


@pytest.mark.parametrize("failure", [AttributeError, OSError])
def test_optional_native_trim_is_not_a_readiness_requirement(monkeypatch, failure):
    monkeypatch.setattr(startup_memory.sys, "platform", "linux")
    monkeypatch.setattr(startup_memory.gc, "collect", lambda: None)

    def unavailable(_):
        raise failure("unavailable")

    monkeypatch.setattr(startup_memory.ctypes, "CDLL", unavailable)
    startup_memory.release_startup_memory()
