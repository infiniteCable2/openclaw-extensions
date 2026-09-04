# Local media contract v1

This directory owns the implementation-neutral contract between the native
OpenClaw plugin and local media services. `openapi.yaml` is the executable v1
HTTP contract.

The contract defines:

- separate liveness, readiness, and content-free status responses;
- bounded binary audio upload for transcription;
- bounded text input and binary audio output for synthesis;
- transport cancellation through request abort/disconnect; a running model call
  may finish internally before the worker becomes available again;
- requested model and content-free observed compute backend;
- closed error codes for overload, timeout, cancellation, unavailable
  accelerator, unsupported media, and inference failure.

The contract will not contain Voicecore names, OpenClaw session identifiers,
Matrix identifiers, phone numbers, transcripts in diagnostics, or hardware
lease credentials.

The `/ready` route is the OpenClaw `localService.healthUrl`. It must not return
2xx merely because the process or TCP listener is alive. It returns 2xx only
after the model is loaded on the requested GPU backend. When an accelerator
lease is required, the lease-owning supervisor starts the worker only after
acquisition and terminates it on lease loss; media workers do not infer or
duplicate accelerator state.
