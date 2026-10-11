from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "kitten_artifact", Path(__file__).resolve().parents[1] / "deploy/kitten2/model_artifact.py",
)
assert SPEC is not None and SPEC.loader is not None
artifact = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(artifact)


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    expected = {}
    for index, name in enumerate(artifact.expected_files()):
        content = f"synthetic-{index}".encode()
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        expected[name] = (len(content), hashlib.sha256(content).hexdigest())
    monkeypatch.setattr(artifact, "expected_files", lambda: expected)
    return tmp_path, expected


def test_minimal_bundle_manifest_round_trip(bundle):
    root, _ = bundle
    manifest = artifact.build_manifest(root)
    (root / artifact.MANIFEST).write_text(json.dumps(manifest))
    assert artifact.validate_model_artifact(root) == manifest
    assert manifest["decoder"] == "default" and manifest["weights"] == "packed"


@pytest.mark.parametrize("change", ["size", "digest", "extra", "manifest", "empty-directory"])
def test_bundle_rejects_mutation(bundle, change):
    root, files = bundle
    manifest = artifact.build_manifest(root)
    (root / artifact.MANIFEST).write_text(json.dumps(manifest))
    path = root / next(iter(files))
    if change == "size":
        path.write_bytes(path.read_bytes() + b"x")
    elif change == "digest":
        path.write_bytes(b"x" * path.stat().st_size)
    elif change == "extra":
        (root / "additional-model.pt").write_bytes(b"unreviewed")
    elif change == "empty-directory":
        (root / "shared-cache").mkdir()
    else:
        manifest["codec_revision"] = "unreviewed"
        (root / artifact.MANIFEST).write_text(json.dumps(manifest))
    with pytest.raises(artifact.ModelArtifactError):
        artifact.validate_model_artifact(root)


def test_offline_cache_main_is_pinned_and_has_no_shared_weights():
    files = artifact.expected_files()
    ref = "cache/models--ResembleAI--chatterbox-turbo/refs/main"
    assert files[ref] == (40, hashlib.sha256(artifact.PINS["codec_revision"].encode()).hexdigest())
    assert len(files) == 15
    assert not any("whisper" in name or "voices/" in name or "student" in name for name in files)
