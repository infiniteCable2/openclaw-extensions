from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest


SERVICE_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = SERVICE_ROOT / "deploy" / "chatterbox" / "source_artifact.py"
SPEC = importlib.util.spec_from_file_location("openclaw_tts_source_artifact", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
source_artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(source_artifact)


def _fixture(path: Path) -> None:
    (path / "src" / "package").mkdir(parents=True)
    (path / "src" / "package" / "__init__.py").write_text(
        "VERSION = 'fixture'\n", encoding="utf-8"
    )
    executable = path / "run.sh"
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o755)


def test_source_manifest_round_trip_is_identity_bound(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _fixture(source)

    written = source_artifact.write_manifest(source, "chatterbox")
    verified = source_artifact.validate_source_artifact(source, "chatterbox")

    assert verified == written
    assert verified["revision"] == source_artifact.PROFILES["chatterbox"][
        "revision"
    ]
    assert verified["patch_sha256"] is not None
    assert verified["offline_tokenizer_patch_sha256"] is not None
    assert verified["file_count"] == 2
    assert source_artifact.MANIFEST_NAME == "openclaw-source-manifest.json"


def test_source_manifest_rejects_modified_file(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _fixture(source)
    source_artifact.write_manifest(source, "perth")
    (source / "src" / "package" / "__init__.py").write_text(
        "tampered\n", encoding="utf-8"
    )

    with pytest.raises(source_artifact.SourceArtifactError, match="diverges"):
        source_artifact.validate_source_artifact(source, "perth")


def test_unpatched_source_profiles_keep_their_existing_manifest_identity(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    _fixture(source)

    manifest = source_artifact.build_manifest(source, "perth")

    assert manifest["patch_sha256"] is None
    assert "offline_tokenizer_patch_sha256" not in manifest


def test_source_manifest_rejects_added_file(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _fixture(source)
    source_artifact.write_manifest(source, "s3tokenizer")
    (source / "unexpected.py").write_text("pass\n", encoding="utf-8")

    with pytest.raises(source_artifact.SourceArtifactError, match="diverges"):
        source_artifact.validate_source_artifact(source, "s3tokenizer")


def test_source_manifest_rejects_vcs_metadata(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _fixture(source)
    (source / ".git").mkdir()
    (source / ".git" / "config").write_text("fixture", encoding="utf-8")

    with pytest.raises(source_artifact.SourceArtifactError, match="VCS metadata"):
        source_artifact.build_manifest(source, "perth")


def test_source_manifest_rejects_symlink(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _fixture(source)
    link = source / "linked.py"
    try:
        link.symlink_to(source / "src" / "package" / "__init__.py")
    except OSError:
        pytest.skip("symlinks are unavailable in this test environment")

    with pytest.raises(source_artifact.SourceArtifactError, match="symlink"):
        source_artifact.build_manifest(source, "chatterbox")


def test_source_manifest_rejects_unknown_identity_in_manifest(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _fixture(source)
    source_artifact.write_manifest(source, "chatterbox")
    manifest_path = source / source_artifact.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["revision"] = "unknown"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(source_artifact.SourceArtifactError, match="diverges"):
        source_artifact.validate_source_artifact(source, "chatterbox")
