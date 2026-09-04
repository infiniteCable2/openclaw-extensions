from __future__ import annotations

import argparse
import signal
from pathlib import Path

from .client import AcceleratorClient
from .runner import LeaseSupervisor, RunnerConfig


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run one local worker under a required accelerator lease"
    )
    parser.add_argument(
        "--socket-path",
        type=Path,
        default=Path("/run/openclaw-accelerator/accelerator.sock"),
    )
    parser.add_argument("--accelerator-id", default="gpu0")
    parser.add_argument("--consumer", required=True)
    parser.add_argument("--ttl-seconds", type=float, default=300.0)
    parser.add_argument("--renew-interval-seconds", type=float, default=20.0)
    parser.add_argument("--renewal-failure-grace-seconds", type=float, default=20.0)
    parser.add_argument("--broker-timeout-seconds", type=float, default=60.0)
    parser.add_argument("--shutdown-timeout-seconds", type=float, default=20.0)
    parser.add_argument("worker", nargs=argparse.REMAINDER)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    command = list(args.worker)
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        raise SystemExit("worker command is required after --")
    executable = Path(command[0])
    if not executable.is_absolute() or not executable.is_file():
        raise SystemExit("worker executable must be an existing absolute file")

    client = AcceleratorClient(
        args.socket_path,
        timeout_seconds=args.broker_timeout_seconds,
    )
    config = RunnerConfig(
        accelerator_id=args.accelerator_id,
        consumer=args.consumer,
        ttl_seconds=args.ttl_seconds,
        renew_interval_seconds=args.renew_interval_seconds,
        renewal_failure_grace_seconds=args.renewal_failure_grace_seconds,
        shutdown_timeout_seconds=args.shutdown_timeout_seconds,
    )
    try:
        config.validate(broker_timeout_seconds=args.broker_timeout_seconds)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    supervisor = LeaseSupervisor()
    previous_handlers: dict[int, object] = {}
    for signal_number in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[signal_number] = signal.getsignal(signal_number)
        signal.signal(
            signal_number,
            lambda received, _frame, owner=supervisor: owner.request_stop(received),
        )
    try:
        exit_code = supervisor.run(
            client=client,
            config=config,
            command=command,
            broker_timeout_seconds=args.broker_timeout_seconds,
        )
    finally:
        for signal_number, handler in previous_handlers.items():
            signal.signal(signal_number, handler)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
