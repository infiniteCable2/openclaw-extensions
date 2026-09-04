#!/usr/bin/env python3
"""Create and verify immutable source-only Chatterbox runtime artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any


SCHEMA_VERSION = 1
MANIFEST_NAME = "openclaw-source-manifest.json"
PROFILES = {
    "chatterbox": {
        "repository": "https://github.com/resemble-ai/chatterbox.git",
        "revision": "5de7a54aa4e5e2baadb0182dde554908b48b85c2",
        "patch_sha256": (
            "16ecc098c9a1d9a7fc1cdfbf223b17b90dbbc0f752dd9850de2fbd5e26c9c263"
        ),
        "offline_tokenizer_patch_sha256": (
            "45dc46b21b7b089347892d16ccf7c2ea7f0832d53c541165c46ddff8e8af843e"
        ),
    },
    "perth": {
        "repository": "https://github.com/resemble-ai/Perth.git",
        "revision": "ce86c49d029f42272c1902eccb675556b9ed2330",
        "patch_sha256": None,
    },
    "s3tokenizer": {
        "repository": "https://github.com/xingchensong/S3Tokenizer.git",
        "revision": "9bf5d845b5e043ffaf4657f4942939091c7697a2",
        "patch_sha256": None,
    },
}


class SourceArtifactError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_source_dir(value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise SourceArtifactError("source artifact path must be absolute")
    if path == Path(path.anchor):
        raise SourceArtifactError("source artifact path must not be a filesystem root")
    if path.is_symlink():
        raise SourceArtifactError("source artifact path must not be a symlink")
    resolved = path.resolve(strict=True)
    if not resolved.is_dir():
        raise SourceArtifactError("source artifact directory is absent")
    return resolved


def _inspect_tree(path: Path) -> tuple[list[str], list[dict[str, Any]]]:
    directories: list[str] = []
    files: list[dict[str, Any]] = []
    for item in sorted(path.rglob("*"), key=lambda entry: entry.as_posix()):
        relative = item.relative_to(path)
        relative_name = relative.as_posix()
        if relative_name == MANIFEST_NAME:
            continue
        if ".git" in relative.parts:
            raise SourceArtifactError("source artifact contains VCS metadata")
        item_stat = item.lstat()
        if stat.S_ISLNK(item_stat.st_mode):
            raise SourceArtifactError(
                f"source artifact contains symlink {relative_name!r}"
            )
        if stat.S_ISDIR(item_stat.st_mode):
            directories.append(relative_name)
            continue
        if not stat.S_ISREG(item_stat.st_mode):
            raise SourceArtifactError(
                f"source artifact contains special entry {relative_name!r}"
            )
        files.append(
            {
                "path": relative_name,
                "size_bytes": item_stat.st_size,
                "sha256": _sha256(item),
                "executable": bool(item_stat.st_mode & 0o111),
            }
        )
    if not files:
        raise SourceArtifactError("source artifact contains no files")
    return directories, files


def build_manifest(path: Path, profile: str) -> dict[str, Any]:
    path = _validate_source_dir(path)
    try:
        identity = PROFILES[profile]
    except KeyError as exc:
        raise SourceArtifactError(f"unknown source profile {profile!r}") from exc
    directories, files = _inspect_tree(path)
    return {
        "schema_version": SCHEMA_VERSION,
        "profile": profile,
        **identity,
        "directories": directories,
        "files": files,
        "file_count": len(files),
        "total_size_bytes": sum(item["size_bytes"] for item in files),
    }


def write_manifest(path: Path, profile: str) -> dict[str, Any]:
    path = _validate_source_dir(path)
    manifest = build_manifest(path, profile)
    target = path / MANIFEST_NAME
    if target.exists() or target.is_symlink():
        raise SourceArtifactError("source artifact manifest already exists")
    payload = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    if os.name == "posix":
        directory_descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    return manifest


def validate_source_artifact(path: Path, profile: str) -> dict[str, Any]:
    path = _validate_source_dir(path)
    target = path / MANIFEST_NAME
    if target.is_symlink() or not target.is_file():
        raise SourceArtifactError("source artifact manifest is absent or unsafe")
    try:
        stored = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SourceArtifactError("source artifact manifest is invalid") from exc
    expected = build_manifest(path, profile)
    if stored != expected:
        raise SourceArtifactError("source artifact diverges from its manifest")
    return expected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--profile", required=True, choices=sorted(PROFILES))
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--write-manifest", action="store_true")
    operation.add_argument("--verify-only", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    try:
        if args.write_manifest:
            manifest = write_manifest(args.source_dir, args.profile)
            status = "completed"
        else:
            manifest = validate_source_artifact(args.source_dir, args.profile)
            status = "verified"
        if not args.quiet:
            print(
                json.dumps(
                    {
                        "status": status,
                        "profile": manifest["profile"],
                        "revision": manifest["revision"],
                        "patch_sha256": manifest["patch_sha256"],
                        "offline_tokenizer_patch_sha256": manifest.get(
                            "offline_tokenizer_patch_sha256"
                        ),
                        "file_count": manifest["file_count"],
                        "total_size_bytes": manifest["total_size_bytes"],
                        "full_hash_verified": True,
                    },
                    indent=2,
                    sort_keys=True,
                )
            )
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
