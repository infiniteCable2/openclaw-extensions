# Embedding installation

Select a reviewed immutable source release through the dedicated
`/srv/openclaw-extensions/embedding-current` symlink. The unit runs the two
dependency-free packages with the system Python 3.13. Run the service as the
`openclaw` account with membership in the accelerator socket group and bind
only to `127.0.0.1`.

The shipped unit contains the non-host-specific example accelerator id `gpu0`.
Production installation must replace it with the sole validated id from the
root-owned broker configuration, preferably through a root-owned systemd
drop-in. Never infer the id from an agent request.

Configure OpenClaw with a dedicated model provider whose API is `ollama` and
whose base URL is the embedding service loopback origin. Then set
`memory.search.provider` to that provider, select the exact model, set fallback
to `none`, and enable cross-conversation memory only on explicitly personal
agents. Keep internal/system agents disabled explicitly.

When the broker reports that unloading is not requested, the service keeps
the Ollama model resident and preserves its lease. Once the broker requests
unloading, the existing `--idle-release-seconds` interval still decides when
the service unloads and releases that lease. Active embedding requests are
never interrupted at a schedule boundary.

For opt-in autonomous daytime loading, add `--prewarm-from-policy` to the
embedding service command only after the broker with policy subscriptions has
been selected. The persistent embedding service then renews a CPU-only policy
lease even while Ollama has no model loaded. On the first valid daytime policy
it makes one bounded synthetic embedding request to load and verify GPU
residency; a failed attempt is retried after 30 seconds. Its existing GPU
demand lease remains tied to actual model residency, and the ordinary idle
interval still controls unloading at night. Without this flag the previous
on-request behavior is unchanged.

Before selection, validate the package, service hardening, exact Ollama model
digest, a synthetic 1024-dimensional non-zero embedding, and broker-confirmed
unload after the idle interval. Back up the OpenClaw configuration and service
unit before cutover; roll both back together.
