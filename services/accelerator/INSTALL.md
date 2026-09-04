# Accelerator installation

The accelerator package has two separate trust zones: an unprivileged lease
runner installed in the worker runtime, and a narrow root-owned socket-activated
hardware broker. OpenClaw and its agents never receive a hardware-control tool.

## Broker

Install reviewed copies of `broker.py` and `cuda_driver_probe.py` at
`/usr/lib/openclaw-accelerator/`, owned by root and not writable by the
OpenClaw account. Install a host-specific root-owned `0640`
`/etc/openclaw-accelerator/config.json` validated against
`contracts/accelerator-v1/broker-config.schema.json`.

Install the files in `systemd/` through `systemd-sysusers` and
`systemd-tmpfiles`, reload systemd, and enable only
`openclaw-accelerator.socket`. Socket activation starts the broker when a
worker requests a lease. The OpenClaw account receives socket access solely
through the `openclaw-accelerator` group.

The host profile must exactly identify every PCI function in the configured
branch, the NVIDIA device, its audio function, and the fixed persistence
service. Do not infer or accept this topology from a client request.

## Runner and OpenClaw

Install the Python package in a root-owned Python 3.13 environment. For each
GPU worker configure exactly one mode:

- `disabled`: OpenClaw invokes the worker directly;
- `required`: OpenClaw invokes `openclaw-accelerator-run`, which acquires and
  renews a lease and then invokes the worker after `--`.

There is no automatic or best-effort mode. In `required` mode any acquisition,
renewal, backend-readiness, or standby proof failure is a failed media request;
the runner kills the worker process group before it releases or loses the
lease. Configure lease TTL and renewal intervals so at least one bounded retry
fits inside the safety window.

## Acceptance and rollback

Before selection, validate the JSON schema and broker unit hardening, start the
socket, acquire and release a non-content test lease, and prove the exact CUDA
backend. After STT/TTS tests, wait through both OpenClaw's worker idle timeout
and the broker cooldown and require broker-confirmed standby.

For rollback stop and disable the candidate socket/service, restore the prior
unit files and host configuration, reload systemd, and restore the previous
OpenClaw local-service commands. Keep the candidate files for content-free
diagnosis until the prior path is healthy.
