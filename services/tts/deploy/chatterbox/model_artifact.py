#!/usr/bin/env python3
"""Provision and verify the pinned offline Chatterbox Multilingual V3 model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import sys
from typing import Any


SCHEMA_VERSION = 1
BACKEND = "chatterbox-multilingual-v3"
MODEL_REPO_ID = "ResembleAI/chatterbox"
MODEL_REVISION = "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18"
MODEL_VARIANT = "v3"
T3_CHECKPOINT = "t3_mtl23ls_v3.safetensors"
DEFAULT_OUTPUT_DIR = Path(
    "/var/lib/openclaw/models/tts/chatterbox-multilingual-v3"
)
MANIFEST_NAME = "openclaw-model-manifest.json"
EXPECTED_FILES: dict[str, dict[str, int | str]] = {
    "Cangjie5_TC.json": {
        "size_bytes": 1_920_163,
        "sha256": "7073fd9de919443ae88e0bd2449917a65fe54898a4413ed1edcc4b67f28bce8c",
    },
    "conds.pt": {
        "size_bytes": 107_374,
        "sha256": "6552d70568833628ba019c6b03459e77fe71ca197d5c560cef9411bee9d87f4e",
    },
    "grapheme_mtl_merged_expanded_v1.json": {
        "size_bytes": 69_989,
        "sha256": "69632f47220a788a52ce2661d096453c5655e9bf25289d89a8d832c46ee07dbf",
    },
    "s3gen.pt": {
        "size_bytes": 1_057_165_844,
        "sha256": "9b9ff07e60b20c136e2b1b3d7563a24604e8d2c4c267888d1ee929dd0151d2a3",
    },
    T3_CHECKPOINT: {
        "size_bytes": 2_143_989_928,
        "sha256": "5abca8321ede76f8e61f1cc0d19aea6c946b28871017ce8726f8a69203f05953",
    },
    "ve.pt": {
        "size_bytes": 5_698_626,
        "sha256": "4b16d836bc598509860f6fa068165a8bb5e9ac84f05582dfcf278a5a372879f1",
    },
}
REQUIRED_FILES = frozenset(EXPECTED_FILES)


class ModelArtifactError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_output_path(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise ModelArtifactError("model artifact path must be absolute")
    if path == Path(path.anchor):
        raise ModelArtifactError("model artifact path must not be a filesystem root")
    if path.is_symlink():
        raise ModelArtifactError("model artifact path must not be a symlink")
    return path


def _artifact_files(path: Path) -> list[Path]:
    files: list[Path] = []
    for child in sorted(path.iterdir(), key=lambda item: item.name):
        if child.name == MANIFEST_NAME:
            continue
        if child.is_symlink():
            raise ModelArtifactError(f"model artifact contains symlink {child.name!r}")
        if not child.is_file():
            raise ModelArtifactError(
                f"model artifact contains unknown non-file entry {child.name!r}"
            )
        files.append(child)
    return files


def build_manifest(path: Path) -> dict[str, Any]:
    path = _validate_output_path(path)
    files = _artifact_files(path)
    present = {item.name for item in files}
    missing = sorted(REQUIRED_FILES - present)
    if missing:
        raise ModelArtifactError(f"model artifact lacks required files: {missing}")
    unknown = sorted(present - REQUIRED_FILES)
    if unknown:
        raise ModelArtifactError(f"model artifact contains unknown files: {unknown}")

    records = []
    for item in files:
        expected = EXPECTED_FILES[item.name]
        actual_size = item.stat().st_size
        if actual_size != expected["size_bytes"]:
            raise ModelArtifactError(f"size mismatch for model file {item.name!r}")
        actual_hash = _sha256(item)
        if actual_hash != expected["sha256"]:
            raise ModelArtifactError(f"digest mismatch for model file {item.name!r}")
        records.append({
            "name": item.name,
            "size_bytes": actual_size,
            "sha256": actual_hash,
        })
    return {
        "schema_version": SCHEMA_VERSION,
        "backend": BACKEND,
        "model_repo_id": MODEL_REPO_ID,
        "model_revision": MODEL_REVISION,
        "model_variant": MODEL_VARIANT,
        "t3_checkpoint": T3_CHECKPOINT,
        "files": records,
        "total_size_bytes": sum(record["size_bytes"] for record in records),
    }


def write_manifest(path: Path) -> dict[str, Any]:
    manifest = build_manifest(path)
    manifest_path = path / MANIFEST_NAME
    if manifest_path.exists() or manifest_path.is_symlink():
        raise ModelArtifactError("model artifact manifest already exists")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    manifest_path.chmod(0o640)
    return manifest


def validate_model_artifact(path: Path, *, full_hash: bool = True) -> dict[str, Any]:
    path = _validate_output_path(path)
    if not path.is_dir():
        raise ModelArtifactError("model artifact directory is absent")
    manifest_path = path / MANIFEST_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ModelArtifactError("model artifact manifest is absent or unsafe")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ModelArtifactError("model artifact manifest is invalid") from exc

    expected_header = {
        "schema_version": SCHEMA_VERSION,
        "backend": BACKEND,
        "model_repo_id": MODEL_REPO_ID,
        "model_revision": MODEL_REVISION,
        "model_variant": MODEL_VARIANT,
        "t3_checkpoint": T3_CHECKPOINT,
    }
    for key, expected in expected_header.items():
        if manifest.get(key) != expected:
            raise ModelArtifactError(f"model artifact manifest uses unknown {key}")

    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise ModelArtifactError("model artifact manifest lacks file records")
    if any(not isinstance(record, dict) for record in records):
        raise ModelArtifactError("model artifact manifest contains an invalid file record")

    actual_files = _artifact_files(path)
    actual_names = [item.name for item in actual_files]
    recorded_names = [record.get("name") for record in records]
    if actual_names != recorded_names or len(set(recorded_names)) != len(recorded_names):
        raise ModelArtifactError("model artifact files diverge from the manifest")
    if set(actual_names) != REQUIRED_FILES:
        raise ModelArtifactError("model artifact file set is unknown")

    total_size = 0
    for item, record in zip(actual_files, records, strict=True):
        pinned = EXPECTED_FILES[item.name]
        expected_size = pinned["size_bytes"]
        expected_hash = pinned["sha256"]
        if record.get("size_bytes") != expected_size:
            raise ModelArtifactError(
                f"manifest size mismatch for model file {item.name!r}"
            )
        if record.get("sha256") != expected_hash:
            raise ModelArtifactError(
                f"manifest digest mismatch for model file {item.name!r}"
            )
        if item.stat().st_size != expected_size:
            raise ModelArtifactError(f"size mismatch for model file {item.name!r}")
        if full_hash and _sha256(item) != expected_hash:
            raise ModelArtifactError(f"digest mismatch for model file {item.name!r}")
        total_size += expected_size

    if manifest.get("total_size_bytes") != total_size:
        raise ModelArtifactError("model artifact total size diverges from the manifest")
    return manifest


def _harden_artifact(path: Path) -> None:
    path.chmod(0o750)
    for item in path.iterdir():
        if item.is_file() and not item.is_symlink():
            item.chmod(0o640)


def provision_model(path: Path) -> tuple[str, dict[str, Any]]:
    path = _validate_output_path(path)
    if path.exists():
        return "already_complete", validate_model_artifact(path)

    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    if path.parent.is_symlink():
        raise ModelArtifactError("model artifact parent must not be a symlink")
    staging = path.parent / f".{path.name}.partial-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(
            repo_id=MODEL_REPO_ID,
            revision=MODEL_REVISION,
            local_dir=staging,
            allow_patterns=sorted(REQUIRED_FILES),
        )
        metadata_dir = staging / ".cache"
        if metadata_dir.exists():
            shutil.rmtree(metadata_dir)
        manifest = write_manifest(staging)
        _harden_artifact(staging)
        validate_model_artifact(staging)
        os.replace(staging, path)
        return "completed", manifest
    except Exception:
        if staging.exists() and not staging.is_symlink():
            shutil.rmtree(staging)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--verify-only", action="store_true")
    operation.add_argument("--write-manifest", action="store_true")
    parser.add_argument("--metadata-only", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    try:
        output_dir = _validate_output_path(args.output_dir)
        if args.write_manifest:
            manifest = write_manifest(output_dir)
            validate_model_artifact(output_dir)
            status = "adopted"
        elif args.verify_only:
            manifest = validate_model_artifact(
                output_dir,
                full_hash=not args.metadata_only,
            )
            status = "verified"
        else:
            status, manifest = provision_model(output_dir)
        if not args.quiet:
            print(json.dumps({
                "status": status,
                "backend": manifest["backend"],
                "model_repo_id": manifest["model_repo_id"],
                "model_revision": manifest["model_revision"],
                "model_variant": manifest["model_variant"],
                "t3_checkpoint": manifest["t3_checkpoint"],
                "file_count": len(manifest["files"]),
                "total_size_bytes": manifest["total_size_bytes"],
                "full_hash_verified": not args.metadata_only,
            }, indent=2, sort_keys=True))
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
