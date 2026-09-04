#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from typing import Any

from packaging.utils import InvalidWheelFilename, parse_wheel_filename

from verify_environment_lock import (
    normalized_lock,
    parse_exact_requirements,
)


MANIFEST_NAME = "openclaw-wheelhouse-manifest.json"
MANIFEST_VERSION = 1


class WheelhouseValidationError(ValueError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_wheelhouse_directory(path: Path) -> Path:
    if path.is_symlink():
        raise WheelhouseValidationError("wheelhouse must not be a symlink")
    resolved = path.resolve(strict=True)
    if not resolved.is_dir():
        raise WheelhouseValidationError("wheelhouse is not a directory")
    return resolved


def inspect_wheels(
    wheelhouse: Path, expected: dict[str, str]
) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    discovered: dict[str, str] = {}
    for path in sorted(wheelhouse.iterdir(), key=lambda item: item.name):
        if path.name == MANIFEST_NAME:
            continue
        file_stat = path.lstat()
        if not stat.S_ISREG(file_stat.st_mode) or path.is_symlink():
            raise WheelhouseValidationError(
                f"wheelhouse entry {path.name!r} is not a regular file"
            )
        if path.suffix != ".whl":
            raise WheelhouseValidationError(
                f"wheelhouse entry {path.name!r} is not a wheel"
            )
        try:
            distribution, version, _build, _tags = parse_wheel_filename(path.name)
        except InvalidWheelFilename as exc:
            raise WheelhouseValidationError(
                f"invalid wheel filename {path.name!r}"
            ) from exc
        name = str(distribution)
        if name in discovered:
            raise WheelhouseValidationError(
                f"wheelhouse contains multiple artifacts for {name!r}"
            )
        discovered[name] = str(version)
        artifacts.append(
            {
                "filename": path.name,
                "sha256": sha256_file(path),
                "size_bytes": file_stat.st_size,
            }
        )

    missing = sorted(expected.keys() - discovered.keys())
    unexpected = sorted(discovered.keys() - expected.keys())
    mismatched = sorted(
        name
        for name in expected.keys() & discovered.keys()
        if expected[name] != discovered[name]
    )
    if missing or unexpected or mismatched:
        raise WheelhouseValidationError(
            "wheelhouse differs from lock: "
            f"missing={missing}, unexpected={unexpected}, "
            f"version_mismatches={mismatched}"
        )
    return artifacts


def build_manifest(
    wheelhouse: Path, lock_file: Path
) -> dict[str, Any]:
    expected = parse_exact_requirements(
        lock_file.read_text(encoding="utf-8").splitlines(),
        source=str(lock_file),
    )
    serialized_lock = normalized_lock(expected)
    artifacts = inspect_wheels(wheelhouse, expected)
    return {
        "manifest_version": MANIFEST_VERSION,
        "distribution_count": len(expected),
        "artifact_count": len(artifacts),
        "normalized_lock_sha256": hashlib.sha256(serialized_lock).hexdigest(),
        "artifacts": artifacts,
    }


def write_manifest(wheelhouse: Path, manifest: dict[str, Any]) -> Path:
    target = wheelhouse / MANIFEST_NAME
    temporary = wheelhouse / f".{MANIFEST_NAME}.{os.getpid()}.tmp"
    if target.exists() or target.is_symlink():
        raise WheelhouseValidationError("wheelhouse manifest already exists")
    payload = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        if os.name == "posix":
            directory_descriptor = os.open(wheelhouse, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()
    return target


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise WheelhouseValidationError("wheelhouse manifest is unreadable") from exc
    if not isinstance(value, dict):
        raise WheelhouseValidationError("wheelhouse manifest must be an object")
    return value


def verify_manifest(wheelhouse: Path, lock_file: Path) -> dict[str, Any]:
    manifest_path = wheelhouse / MANIFEST_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise WheelhouseValidationError("wheelhouse manifest is missing or unsafe")
    expected_manifest = build_manifest(wheelhouse, lock_file)
    stored_manifest = load_manifest(manifest_path)
    if stored_manifest != expected_manifest:
        raise WheelhouseValidationError("wheelhouse manifest verification failed")
    return {
        "status": "verified",
        "distribution_count": expected_manifest["distribution_count"],
        "artifact_count": expected_manifest["artifact_count"],
        "normalized_lock_sha256": expected_manifest["normalized_lock_sha256"],
        "manifest_sha256": sha256_file(manifest_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create or verify a complete OpenClaw TTS wheelhouse manifest."
    )
    parser.add_argument("--wheelhouse", required=True, type=Path)
    parser.add_argument("--lock-file", required=True, type=Path)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--write-manifest", action="store_true")
    operation.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()

    try:
        wheelhouse = validate_wheelhouse_directory(args.wheelhouse)
        if args.write_manifest:
            write_manifest(wheelhouse, build_manifest(wheelhouse, args.lock_file))
        result = verify_manifest(wheelhouse, args.lock_file)
    except (OSError, WheelhouseValidationError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
