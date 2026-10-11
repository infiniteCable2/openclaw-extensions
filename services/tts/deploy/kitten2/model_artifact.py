#!/usr/bin/env python3
"""Verify a minimal offline Kitten 2 bundle; never download or accept a license."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

PINS = json.loads(Path(__file__).with_name("model-pins.json").read_text(encoding="utf-8"))
MANIFEST = "openclaw-model-manifest.json"


class ModelArtifactError(ValueError):
    pass


def expected_files() -> dict[str, tuple[int, str]]:
    files = {f"model/{name}": tuple(record) for name, record in PINS["model_files"].items()}
    repository = "cache/models--ResembleAI--chatterbox-turbo"
    revision = PINS["codec_revision"]
    files[f"{repository}/snapshots/{revision}/s3gen_meanflow.safetensors"] = tuple(PINS["codec_file"])
    # Upstream's codec requests main without a revision; the isolated offline
    # cache binds that name to the reviewed snapshot, with regular files only.
    reference = revision.encode("ascii")
    files[f"{repository}/refs/main"] = (len(reference), hashlib.sha256(reference).hexdigest())
    return files


def build_manifest(root: Path) -> dict:
    if not root.is_absolute() or root == Path(root.anchor) or root.is_symlink() or not root.is_dir():
        raise ModelArtifactError("artifact root must be an existing absolute non-symlink directory")
    expected = expected_files()
    directories = {parent.as_posix() for name in expected for parent in Path(name).parents
                   if parent != Path(".")}
    files: dict[str, Path] = {}
    for child in root.rglob("*"):
        name = child.relative_to(root).as_posix()
        if child.is_symlink():
            raise ModelArtifactError("symlinks are forbidden in the offline bundle")
        if child.is_dir():
            if name not in directories:
                raise ModelArtifactError("unexpected artifact directory")
        elif child.is_file():
            if name != MANIFEST:
                files[name] = child
        else:
            raise ModelArtifactError("artifact entries must be regular files or directories")
    if set(files) != set(expected):
        raise ModelArtifactError("artifact file set differs from the pinned minimal bundle")
    records = []
    for name in sorted(expected):
        size, digest = expected[name]
        path = files[name]
        if path.stat().st_size != size:
            raise ModelArtifactError("artifact file size differs from pin")
        with path.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != digest:
            raise ModelArtifactError("artifact file digest differs from pin")
        records.append({"name": name, "size_bytes": size, "sha256": digest})
    return {
        "schema_version": 1, "backend": PINS["backend"], "sdk_commit": PINS["sdk_commit"],
        "model_revision": PINS["model_revision"], "codec_revision": PINS["codec_revision"],
        "weights": PINS["weights"], "decoder": PINS["decoder"], "files": records,
        "total_size_bytes": sum(record["size_bytes"] for record in records),
    }


def validate_model_artifact(root: Path) -> dict:
    manifest_path = root / MANIFEST
    if manifest_path.is_symlink() or not manifest_path.is_file() or manifest_path.stat().st_size > 65536:
        raise ModelArtifactError("bounded regular manifest is required")
    actual = build_manifest(root)
    try:
        stored = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise ModelArtifactError("invalid manifest") from error
    if actual != stored:
        raise ModelArtifactError("manifest differs from independently verified pins")
    return actual


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--write-manifest", action="store_true")
    args = parser.parse_args()
    try:
        if args.write_manifest:
            result = build_manifest(args.artifact_root)
            # Exclusive creation prevents adoption from overwriting old evidence.
            with (args.artifact_root / MANIFEST).open("x", encoding="utf-8") as handle:
                json.dump(result, handle, indent=2, sort_keys=True)
                handle.write("\n")
        result = validate_model_artifact(args.artifact_root)
        print(json.dumps({"status": "verified", "backend": result["backend"],
                          "file_count": len(result["files"]),
                          "total_size_bytes": result["total_size_bytes"]}))
        return 0
    except (ModelArtifactError, OSError, ValueError):
        # No operator paths, media or downloaded content in diagnostic output.
        print("Kitten offline artifact validation failed")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
