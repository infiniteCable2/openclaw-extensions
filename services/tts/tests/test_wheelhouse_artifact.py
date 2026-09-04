from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MODULE_DIR = SERVICE_ROOT / "deploy"
sys.path.insert(0, str(MODULE_DIR))
try:
    SPEC = importlib.util.spec_from_file_location(
        "openclaw_tts_wheelhouse_artifact", MODULE_DIR / "wheelhouse_artifact.py"
    )
    assert SPEC is not None and SPEC.loader is not None
    ARTIFACT = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(ARTIFACT)
finally:
    sys.path.pop(0)


def write_lock(path: Path) -> None:
    path.write_text("Alpha==1.0\nbeta_package==2.0\n", encoding="utf-8")


def write_wheels(path: Path) -> None:
    (path / "Alpha-1.0-py3-none-any.whl").write_bytes(b"alpha-wheel")
    (path / "beta_package-2.0-py3-none-any.whl").write_bytes(b"beta-wheel")


def test_wheelhouse_manifest_round_trip(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    lock_file = tmp_path / "constraints.txt"
    write_lock(lock_file)
    write_wheels(wheelhouse)

    manifest = ARTIFACT.build_manifest(wheelhouse, lock_file)
    manifest_path = ARTIFACT.write_manifest(wheelhouse, manifest)
    result = ARTIFACT.verify_manifest(wheelhouse, lock_file)

    if sys.platform != "win32":
        assert manifest_path.stat().st_mode & 0o777 == 0o600
    assert result["status"] == "verified"
    assert result["distribution_count"] == 2
    assert result["artifact_count"] == 2
    assert len(result["manifest_sha256"]) == 64
    assert ARTIFACT.MANIFEST_NAME == "openclaw-wheelhouse-manifest.json"


def test_wheelhouse_manifest_detects_artifact_mutation(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    lock_file = tmp_path / "constraints.txt"
    write_lock(lock_file)
    write_wheels(wheelhouse)
    ARTIFACT.write_manifest(
        wheelhouse, ARTIFACT.build_manifest(wheelhouse, lock_file)
    )

    (wheelhouse / "Alpha-1.0-py3-none-any.whl").write_bytes(b"modified")

    with pytest.raises(
        ARTIFACT.WheelhouseValidationError, match="verification failed"
    ):
        ARTIFACT.verify_manifest(wheelhouse, lock_file)


def test_wheelhouse_rejects_missing_and_unexpected_distributions(
    tmp_path: Path,
) -> None:
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    lock_file = tmp_path / "constraints.txt"
    write_lock(lock_file)
    (wheelhouse / "gamma-3.0-py3-none-any.whl").write_bytes(b"gamma")

    with pytest.raises(ARTIFACT.WheelhouseValidationError) as error:
        ARTIFACT.build_manifest(wheelhouse, lock_file)

    message = str(error.value)
    assert "missing=['alpha', 'beta-package']" in message
    assert "unexpected=['gamma']" in message


def test_wheelhouse_rejects_duplicate_distribution_artifacts(
    tmp_path: Path,
) -> None:
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    lock_file = tmp_path / "constraints.txt"
    write_lock(lock_file)
    write_wheels(wheelhouse)
    (wheelhouse / "alpha-1.0-1-py3-none-any.whl").write_bytes(b"duplicate")

    with pytest.raises(
        ARTIFACT.WheelhouseValidationError, match="multiple artifacts"
    ):
        ARTIFACT.build_manifest(wheelhouse, lock_file)


def test_wheelhouse_rejects_non_wheel_entries(tmp_path: Path) -> None:
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    lock_file = tmp_path / "constraints.txt"
    write_lock(lock_file)
    write_wheels(wheelhouse)
    (wheelhouse / "notes.txt").write_text("unexpected", encoding="utf-8")

    with pytest.raises(ARTIFACT.WheelhouseValidationError, match="not a wheel"):
        ARTIFACT.build_manifest(wheelhouse, lock_file)
