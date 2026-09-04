from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = SERVICE_ROOT / "deploy" / "chatterbox" / "model_artifact.py"
SPEC = importlib.util.spec_from_file_location("openclaw_chatterbox_model_artifact", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
model_artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(model_artifact)


def _write_fixture(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path.mkdir()
    expected_files = {}
    for index, name in enumerate(sorted(model_artifact.REQUIRED_FILES), start=1):
        content = f"fixture-{index}".encode("ascii")
        (path / name).write_bytes(content)
        expected_files[name] = {
            "size_bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    monkeypatch.setattr(model_artifact, "EXPECTED_FILES", expected_files)
    monkeypatch.setattr(model_artifact, "REQUIRED_FILES", frozenset(expected_files))


def test_chatterbox_model_manifest_round_trip_is_pinned_to_v3(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)

    written = model_artifact.write_manifest(model_dir)
    verified = model_artifact.validate_model_artifact(model_dir)

    assert verified == written
    assert verified["model_repo_id"] == "ResembleAI/chatterbox"
    assert verified["model_revision"] == model_artifact.MODEL_REVISION
    assert verified["model_variant"] == "v3"
    assert verified["t3_checkpoint"] == "t3_mtl23ls_v3.safetensors"
    assert {record["name"] for record in verified["files"]} == set(
        model_artifact.REQUIRED_FILES
    )
    assert model_artifact.MANIFEST_NAME == "openclaw-model-manifest.json"


def test_chatterbox_cli_adopts_an_existing_pinned_file_set(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
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


def test_chatterbox_model_validation_rejects_modified_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
    model_artifact.write_manifest(model_dir)
    checkpoint = model_dir / model_artifact.T3_CHECKPOINT
    checkpoint.write_bytes(b"x" * checkpoint.stat().st_size)

    with pytest.raises(model_artifact.ModelArtifactError, match="digest mismatch"):
        model_artifact.validate_model_artifact(model_dir)


def test_chatterbox_model_validation_rejects_unknown_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
    model_artifact.write_manifest(model_dir)
    manifest_path = model_dir / model_artifact.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["model_revision"] = "unknown"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(model_artifact.ModelArtifactError, match="unknown model_revision"):
        model_artifact.validate_model_artifact(model_dir)


def test_chatterbox_model_metadata_validation_rejects_unpinned_digest(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
    model_artifact.write_manifest(model_dir)
    manifest_path = model_dir / model_artifact.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(model_artifact.ModelArtifactError, match="manifest digest mismatch"):
        model_artifact.validate_model_artifact(model_dir, full_hash=False)


def test_chatterbox_model_validation_rejects_unknown_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
    (model_dir / "legacy-checkpoint.pt").write_bytes(b"legacy")

    with pytest.raises(model_artifact.ModelArtifactError, match="unknown files"):
        model_artifact.build_manifest(model_dir)


def test_chatterbox_model_build_rejects_unpinned_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
    checkpoint = model_dir / model_artifact.T3_CHECKPOINT
    checkpoint.write_bytes(b"x" * checkpoint.stat().st_size)

    with pytest.raises(model_artifact.ModelArtifactError, match="digest mismatch"):
        model_artifact.build_manifest(model_dir)


def test_chatterbox_model_build_rejects_unpinned_size(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "model"
    _write_fixture(model_dir, monkeypatch)
    checkpoint = model_dir / model_artifact.T3_CHECKPOINT
    checkpoint.write_bytes(checkpoint.read_bytes() + b"x")

    with pytest.raises(model_artifact.ModelArtifactError, match="size mismatch"):
        model_artifact.build_manifest(model_dir)


def test_chatterbox_model_pins_exact_upstream_artifacts() -> None:
    assert model_artifact.REQUIRED_FILES == frozenset(model_artifact.EXPECTED_FILES)
    assert len(model_artifact.EXPECTED_FILES) == 6
    assert sum(
        record["size_bytes"] for record in model_artifact.EXPECTED_FILES.values()
    ) == 3_208_951_924
    assert model_artifact.EXPECTED_FILES[model_artifact.T3_CHECKPOINT] == {
        "size_bytes": 2_143_989_928,
        "sha256": "5abca8321ede76f8e61f1cc0d19aea6c946b28871017ce8726f8a69203f05953",
    }
