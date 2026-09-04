# Accelerator lease contract v1

This contract defines the local, content-free boundary between an optional
host accelerator broker and a lease-owning worker supervisor. It is not an
OpenClaw provider or an agent tool.

Transport is one newline-delimited JSON request and response per connection on
a permission-restricted Unix socket. The broker authenticates the peer from
Unix credentials. Requests are limited to 16 KiB and responses to 64 KiB.

Every message has `version: 1`. Supported actions are:

- `acquire`: accelerator id, stable service consumer id, and optional bounded
  TTL;
- `renew`: accelerator id, opaque lease id, and optional bounded TTL;
- `release`: accelerator id and opaque lease id;
- `status`: accelerator id only, for operator diagnostics.

A successful acquire or renew returns `ok: true`, `state: "ready"`, an opaque
`lease_id`, and `expires_at_epoch`. The supervisor must not start a worker
before a successful acquire. It terminates the complete worker process group
before lease expiry when renewal cannot be proven, then attempts release.
When a request omits its TTL, the root-owned profile's bounded default applies.

An error returns `ok: false`, a stable `error_code`, and `retryable`; optional
`error_type` and `error_stage` are bounded content-free classifications. Lease
ids are credentials and must never be logged or exposed through status.

There is no automatic or best-effort mode. Direct worker configuration means
accelerator leasing is disabled. Selecting this supervisor means leasing is
required and failure is closed; it never starts the worker on CPU or against a
different accelerator.

`broker-config.schema.json` is the root-owned host configuration contract. It
allows at most eight explicitly identified Linux PCI/NVIDIA topologies, one
fixed persistence-service unit per topology, bounded readiness/cooldown/lease
timings, and an explicit automatic-power-management switch. Runtime validation
additionally requires `max_lease_ttl_sec` to be greater than or equal to
`default_lease_ttl_sec` and rejects unsafe file ownership, writable config
files, symlinks, unknown fields, and unsupported backends.
