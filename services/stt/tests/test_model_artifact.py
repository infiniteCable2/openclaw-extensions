from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = SERVICE_ROOT / "deploy" / "model_artifact.py"
SPEC = importlib.util.spec_from_file_location("openclaw_stt_model_artifact", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
model_artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(model_artifact)


def _write_fixture(path: Path) -> None:
    path.mkdir()
    for index, name in enumerate(sorted(model_artifact.REQUIRED_FILES), start=1):
        (path / name).write_bytes(f"fixture-{index}".encode("ascii"))


def test_manifest_round_trip_verifies_every_file(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir)

    written = model_artifact.write_manifest(model_dir)
    verified = model_artifact.validate_model_artifact(model_dir)

    assert verified == written
    assert verified["model_repo_id"] == model_artifact.MODEL_REPO_ID
    assert verified["model_revision"] == model_artifact.MODEL_REVISION
    assert {record["name"] for record in verified["files"]} == set(
        model_artifact.REQUIRED_FILES
    )


def test_cli_adopts_an_existing_verified_file_set(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir)
    monkeypatch.setattr(
        model_artifact.sys,
        "argv",
        [
            "model_artifact.py",
            "--output-dir",
            str(model_dir),
            "--write-manifest",
            "--quiet",
        ],
    )

    assert model_artifact.main() == 0
    assert model_artifact.validate_model_artifact(model_dir)["model_revision"] == (
        model_artifact.MODEL_REVISION
    )


def test_validation_rejects_modified_model_file(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir)
    model_artifact.write_manifest(model_dir)
    (model_dir / "model.bin").write_bytes(b"tampered")

    with pytest.raises(model_artifact.ModelArtifactError, match="mismatch"):
        model_artifact.validate_model_artifact(model_dir)


def test_validation_rejects_unknown_manifest_revision(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir)
    model_artifact.write_manifest(model_dir)
    manifest_path = model_dir / model_artifact.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["model_revision"] = "unknown"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(model_artifact.ModelArtifactError, match="unknown model_revision"):
        model_artifact.validate_model_artifact(model_dir)


def test_validation_rejects_symlinked_model_file(tmp_path: Path) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir)
    target = model_dir / "model.bin"
    target.unlink()
    try:
        target.symlink_to(model_dir / "config.json")
    except OSError:
        pytest.skip("symlinks unavailable in this test environment")

    with pytest.raises(model_artifact.ModelArtifactError, match="symlink"):
        model_artifact.build_manifest(model_dir)
