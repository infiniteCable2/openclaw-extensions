# Accelerator lifecycle service

Optional narrow broker for hosts where ordinary worker reaping does not provide
the required power savings. It owns only device allowlisting, renewable leases,
hardware readiness, cooldown, recovery, and broker-confirmed standby.

It is an activatable host resource service, not an OpenClaw model provider and
not an agent-callable tool. Workers use it only when explicitly configured in
`required` mode. If no broker is configured, the feature is disabled. If a
required broker cannot prove a valid lease or the requested backend, the worker
must remain unready and must not fall back to CPU.
