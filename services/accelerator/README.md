# Accelerator lifecycle service

Optional narrow broker for hosts where ordinary worker reaping does not provide
the required power savings. It owns only device allowlisting, renewable leases,
hardware readiness, cooldown, recovery, and broker-confirmed standby.

It is an activatable host resource service, not an OpenClaw model provider and
not an agent-callable tool. Workers use it only when explicitly configured in
`required` mode. If no broker is configured, the feature is disabled. If a
required broker cannot prove a valid lease or the requested backend, the worker
must remain unready and must not fall back to CPU.

## Lease runner

`openclaw-accelerator-run` is the unprivileged, generic service supervisor for
required mode. It acquires a v1 lease before spawning the configured worker,
renews it with a bounded safety window, forwards shutdown to the complete
worker process group, and kills that group before an unproven lease can expire.
The lease is released after worker shutdown. It never logs the worker command,
lease credential, service content, or broker response body.

The worker executable must be an existing absolute path. A typical OpenClaw
`localService.command` points to this runner and places the real STT or TTS
command after `--`. When accelerator management is disabled, point
`localService.command` directly at the worker instead.

The runner is implemented and contract-tested. The privileged hardware broker
is an independently installed root-owned boundary in this package. Until that
neutral broker is installed and accepted on a host, required mode is not ready
for production and must not be redirected to a legacy service.

## Privileged broker

`openclaw-accelerator-broker` implements the v1 Unix-socket protocol for an
explicit allowlist of Linux PCI/NVIDIA accelerator topologies. It preserves the
already proven lifecycle behavior: immutable PCI identity checks, complete
branch inventory validation, peer-credential lease ownership, per-UID rate and
lease limits, renewable TTLs, NVIDIA/CUDA readiness, bounded degraded-state
recovery, idle cooldown, and broker-confirmed detach.

The broker never accepts commands, paths, units, device identifiers, or shell
text from a client. Hardware topology and the one persistence-service unit are
root-owned configuration validated against
`contracts/accelerator-v1/broker-config.schema.json`. Status is content-free
and never includes lease ids.

The `systemd/` templates install the broker separately from OpenClaw. The
root-owned process receives exactly one activated Unix socket, has no network
address family, cannot read OpenClaw configuration or state, and grants socket
access only through the `openclaw-accelerator` group. Its intentionally narrow
remaining privileges are needed for fixed module, service, PCI sysfs, and
device-client operations. Enablement, host-specific topology configuration,
and production acceptance remain deployment decisions rather than package
defaults.

## Deployment layout

- broker and CUDA probe: `/usr/lib/openclaw-accelerator/`;
- root-owned configuration: `/etc/openclaw-accelerator/config.json`;
- permission-restricted socket: `/run/openclaw-accelerator/accelerator.sock`;
- client membership: `openclaw-accelerator` group.

The supplied unit expects the source files to be installed at the fixed paths
above. Release packaging must bind those files and the configuration template
to reviewed hashes before a production cutover.
