from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .client import AcceleratorClient


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check broker-owned local-service idle policy")
    parser.add_argument("--socket-path", type=Path, required=True)
    parser.add_argument("--accelerator-id", required=True)
    args = parser.parse_args(argv)
    try:
        requested, valid_until = AcceleratorClient(
            args.socket_path, timeout_seconds=2.0
        ).standby_policy(args.accelerator_id)
    except Exception:
        # The OpenClaw manager retains the worker and retries on a failed check.
        return 1
    sys.stdout.write(
        json.dumps(
            {"stop": requested, "validUntilEpoch": valid_until},
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
