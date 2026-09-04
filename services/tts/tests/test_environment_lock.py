from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = SERVICE_ROOT / "deploy" / "verify_environment_lock.py"
SPEC = importlib.util.spec_from_file_location("openclaw_tts_environment_lock", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
LOCK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCK)


def test_lock_comparison_is_order_and_distribution_spelling_independent() -> None:
    expected = LOCK.parse_exact_requirements(
        ["typing_extensions==4.15.0", "Flask==3.1.3"], source="expected"
    )
    actual = LOCK.parse_exact_requirements(
        ["flask==3.1.3", "typing-extensions==4.15.0"], source="actual"
    )

    result = LOCK.verify_lock(expected, actual)

    assert result["status"] == "verified"
    assert result["distribution_count"] == 2
    assert result["order_independent"] is True
    assert result["normalized_sha256"] == hashlib.sha256(
        b"flask==3.1.3\ntyping-extensions==4.15.0\n"
    ).hexdigest()


@pytest.mark.parametrize(
    "requirement",
    (
        "package>=1.0",
        "package @ https://example.invalid/package.whl",
        "package==1.0; python_version > '3.12'",
        "--index-url https://example.invalid/simple",
        "-e ../package",
    ),
)
def test_lock_rejects_non_exact_requirements(requirement: str) -> None:
    with pytest.raises(LOCK.LockValidationError, match="not an exact"):
        LOCK.parse_exact_requirements([requirement], source="test")


def test_lock_rejects_canonical_duplicate_names() -> None:
    with pytest.raises(LOCK.LockValidationError, match="duplicate"):
        LOCK.parse_exact_requirements(
            ["typing_extensions==4.15.0", "typing-extensions==4.15.0"],
            source="test",
        )


def test_lock_merges_one_explicit_local_distribution() -> None:
    expected = LOCK.merge_expected_local_distributions(
        {"flask": "3.1.3"},
        ["openclaw-local-tts==0.1.0"],
    )

    assert expected == {
        "flask": "3.1.3",
        "openclaw-local-tts": "0.1.0",
    }


def test_lock_rejects_local_distribution_that_shadows_a_dependency() -> None:
    with pytest.raises(LOCK.LockValidationError, match="duplicate"):
        LOCK.merge_expected_local_distributions(
            {"flask": "3.1.3"},
            ["Flask==3.1.3"],
        )


def test_lock_reports_missing_unexpected_and_mismatched_distributions() -> None:
    with pytest.raises(LOCK.LockValidationError) as error:
        LOCK.verify_lock(
            {"alpha": "1", "beta": "2"},
            {"alpha": "9", "gamma": "3"},
        )

    message = str(error.value)
    assert "missing=['beta']" in message
    assert "unexpected=['gamma']" in message
    assert "version_mismatches=['alpha']" in message


def test_environment_uses_distribution_versions_for_wheel_installs(monkeypatch) -> None:
    completed = SimpleNamespace(
        returncode=0,
        stdout="Flask==3.1.3\nopenclaw-local-tts==0.1.0\n",
    )
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return completed

    monkeypatch.setattr(LOCK.subprocess, "run", fake_run)

    actual = LOCK.environment_freeze()

    assert actual == {"flask": "3.1.3", "openclaw-local-tts": "0.1.0"}
    assert calls[0][0][-3:] == ["--format=freeze", "--exclude", "pip"]
