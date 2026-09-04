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
is deliberately a separate extraction and deployment unit. Until that neutral
broker is installed on a host, required mode is not ready for production and
must not be redirected to a legacy service.
