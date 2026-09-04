#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable


EXACT_REQUIREMENT = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)==(?P<version>[^\s;@]+)$"
)


class LockValidationError(ValueError):
    pass


def canonicalize_distribution_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def parse_exact_requirements(
    lines: Iterable[str], *, source: str
) -> dict[str, str]:
    requirements: dict[str, str] = {}
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = EXACT_REQUIREMENT.fullmatch(line)
        if match is None:
            raise LockValidationError(
                f"{source} line {line_number} is not an exact name==version requirement"
            )
        name = canonicalize_distribution_name(match.group("name"))
        if name in requirements:
            raise LockValidationError(
                f"{source} contains duplicate distribution {name!r}"
            )
        requirements[name] = match.group("version")
    if not requirements:
        raise LockValidationError(f"{source} contains no distributions")
    return requirements


def normalized_lock(requirements: dict[str, str]) -> bytes:
    return "".join(
        f"{name}=={requirements[name]}\n" for name in sorted(requirements)
    ).encode("utf-8")


def merge_expected_local_distributions(
    expected: dict[str, str], values: Iterable[str]
) -> dict[str, str]:
    local = parse_exact_requirements(values, source="expected local distributions")
    duplicates = sorted(expected.keys() & local.keys())
    if duplicates:
        raise LockValidationError(
            f"local distributions duplicate locked dependencies: {duplicates}"
        )
    return {**expected, **local}


def environment_freeze() -> dict[str, str]:
    environment = os.environ.copy()
    environment["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    environment["PIP_NO_CACHE_DIR"] = "1"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "list",
            "--local",
            "--format=freeze",
            "--exclude",
            "pip",
        ],
        check=False,
        capture_output=True,
        env=environment,
        text=True,
    )
    if completed.returncode != 0:
        raise LockValidationError(
            f"pip list failed with exit code {completed.returncode}"
        )
    return parse_exact_requirements(
        completed.stdout.splitlines(), source="installed environment"
    )


def verify_lock(
    expected: dict[str, str], actual: dict[str, str]
) -> dict[str, object]:
    missing = sorted(expected.keys() - actual.keys())
    unexpected = sorted(actual.keys() - expected.keys())
    mismatched = sorted(
        name
        for name in expected.keys() & actual.keys()
        if expected[name] != actual[name]
    )
    if missing or unexpected or mismatched:
        raise LockValidationError(
            "environment differs from lock: "
            f"missing={missing}, unexpected={unexpected}, "
            f"version_mismatches={mismatched}"
        )
    serialized = normalized_lock(expected)
    return {
        "status": "verified",
        "distribution_count": len(expected),
        "normalized_sha256": hashlib.sha256(serialized).hexdigest(),
        "order_independent": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify the current Python environment against an exact lock."
    )
    parser.add_argument("--constraints-file", required=True, type=Path)
    parser.add_argument(
        "--expected-local-distribution",
        action="append",
        default=[],
        metavar="NAME==VERSION",
    )
    args = parser.parse_args()

    try:
        expected = parse_exact_requirements(
            args.constraints_file.read_text(encoding="utf-8").splitlines(),
            source=str(args.constraints_file),
        )
        if args.expected_local_distribution:
            expected = merge_expected_local_distributions(
                expected,
                args.expected_local_distribution,
            )
        result = verify_lock(expected, environment_freeze())
    except (LockValidationError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
