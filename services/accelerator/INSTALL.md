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
`systemd-tmpfiles`, reload systemd, and enable the broker service and socket
when scheduled standby is configured. The service must stay active so its
clock monitor can wake the eGPU at the end of standby even with zero leases.
Without a schedule, socket activation remains sufficient. The OpenClaw account receives socket access solely
through the `openclaw-accelerator` group.

The host profile must exactly identify every PCI function in the configured
branch, the NVIDIA device, its audio function, and the fixed persistence
service. Do not infer or accept this topology from a client request.
For a 23:00–07:00 local standby window, set `standby_schedule` to
`{"timezone":"Europe/Berlin","start":"23:00","end":"07:00"}` and
`idle_timeout_sec` to `10`. The latter is counted from the final lease release;
the broker still checks that no GPU client is using the device before detach.

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

## Scheduled service ownership (candidate, not automatically enabled)

The broker publishes two distinct lease types. A `subscribe_policy` lease is
CPU-only: it renews the time-limited `unload_requested` instruction even while
the model is absent and **does not** prevent hardware standby. A normal GPU
lease is still mandatory while a CUDA worker is alive. At the end of the
standby window the broker itself validates and attaches the hardware, even if
there are no subscribers or GPU leases.

For a scheduled STT/TTS service, run `openclaw-accelerator-service` as the
unprivileged service account under a persistent systemd unit. Give it a
private systemd `RuntimeDirectory`, an absolute `--control-socket` path within
that directory, fixed broker socket/id/consumer parameters and, after `--`,
the same reviewed worker command currently given to the runner. This
CPU-side process owns the policy subscription. It starts an embedded runner
(which owns the GPU lease and worker) when the policy says no unloading is
requested, or when OpenClaw has active demand. It stops the worker only after
the configured idle time and no remaining demand. A missing/expired policy
never causes speculative daytime preloading; active demand still requires a
successful GPU lease.

Point OpenClaw `localService.command` to `openclaw-accelerator-demand` with
the same fixed `--control-socket`, a dedicated `--health-port`, and the worker's
loopback `--worker-health-url`. Set `localService.healthUrl` to the demand
connector's `http://127.0.0.1:<health-port>/ready`, **not** the persistent
worker's `/ready`. OpenClaw skips spawning its local service when the health
URL already succeeds; using the worker URL would lose the demand binding
during daytime prewarm and could stop a live call at the night boundary. The
connector reports ready only while connected to the owner *and* while the
worker reports ready. Retain a bounded readiness timeout. The demand process only holds a local connection
for as long as OpenClaw wants the service. It cannot choose a worker command,
model or accelerator; it also exits when its OpenClaw parent disappears. Keep
`idleStopMs` and `idleStopCheck`, so OpenClaw drops
idle demand at night while retaining it during the daytime policy. The
control socket must be `0600` in a private directory owned by the service
account. Never activate both the previous direct runner command and this
owner for the same worker port.

When no broker is configured, retain direct OpenClaw worker ownership. The
scheduled owner is an opt-in deployment mode, not a new mandatory dependency.

## Acceptance and rollback

Before selection, validate the JSON schema and broker unit hardening, start the
socket, acquire and release a non-content test lease, and prove the exact CUDA
backend. After STT/TTS tests, wait through both OpenClaw's worker idle timeout
and the broker cooldown and require broker-confirmed standby.

For rollback stop and disable the candidate socket/service, restore the prior
unit files and host configuration, reload systemd, and restore the previous
OpenClaw local-service commands. Keep the candidate files for content-free
diagnosis until the prior path is healthy.
