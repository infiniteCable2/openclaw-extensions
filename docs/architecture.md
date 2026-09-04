# Architecture

## Ownership

The native OpenClaw plugin translates provider calls into versioned local
media requests. It does not own an agent, conversation, Matrix room, phone
call, or delivery policy. OpenClaw remains the only orchestration host.

The STT and TTS services own model loading, bounded admission, inference, and
media encoding at their service boundaries. They do not call each other and do
not know which OpenClaw channel caused a request.

The optional accelerator service is a narrow privileged boundary. It validates
a fixed device allowlist, grants renewable leases, reports content-free state,
and performs hardware lifecycle operations. It never receives media or text.

## Lifecycle

OpenClaw acquires a configured local-service lease before sending a provider
request. Concurrent requests share startup and keep the process alive. The
provider request lease is released on success, failure, timeout, or
cancellation. OpenClaw may stop an idle service only after all active leases
are released.

Accelerator state is separate from process state:

1. `standby`: the broker confirms that the accelerator is powered down.
2. `starting`: accelerator acquisition or service startup is in progress.
3. `loading`: the process is live but the requested model is not ready.
4. `ready`: the requested model and accelerator backend are ready.
5. `busy`: at least one admitted inference operation is active.
6. `warm`: no operation is active, but the service remains ready.
7. `cooling`: service demand ended, while hardware standby is still pending.
8. `fault`: the requested backend or lifecycle guarantee cannot be proven.

A successful TCP connection or liveness response is not model readiness.
Likewise, an exited worker is not proof of accelerator standby. Readiness comes
from the model service; standby comes from the accelerator owner.

## Repository splitability

Every top-level package owns its build metadata, tests, and runtime
dependencies. Cross-component integration uses only the versioned contract.
This allows a future repository split by filtered directory history without
changing imports or deployment topology.

The initial repository intentionally avoids Git submodules. Deployments consume
tagged plugin packages and immutable service release artifacts instead of a
mutable multi-repository checkout.
