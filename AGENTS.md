# OpenClaw extensions workspace

This repository contains native OpenClaw integrations and standalone local
media services.

## Architecture

- OpenClaw is the sole owner of agents, sessions, channels, routing, and
  user-visible delivery policy.
- Plugin code uses only public `openclaw/plugin-sdk/*` contracts.
- STT, TTS, and accelerator components remain independently buildable and
  testable. Do not introduce service-to-service source imports.
- Shared wire contracts live under `contracts/`, are versioned, and contain no
  OpenClaw session or channel concepts.
- Voicecore may be inspected as a legacy reference but must never be imported,
  executed, contacted, named in runtime protocols, or required for deployment.
- Do not copy the complete Voicecore Git history. Extract reviewed behavior in
  focused commits after checking licenses, secrets, fixtures, and dependencies.

## Runtime safety

- Local provider endpoints bind to loopback or a permission-restricted local
  socket.
- Bound request size, duration, queue depth, concurrency, output size, and
  shutdown time.
- Propagate deadlines and cancellation through provider, service, worker, and
  codec processes.
- A configured accelerator is fail-closed: readiness requires the requested
  backend and never falls back silently to CPU or cloud execution.
- Distinguish liveness, model readiness, warm idle, accelerator cooldown, and
  broker-confirmed standby.
- Never log media content, transcripts, prompts, credentials, lease tokens,
  caller identities, or private deployment paths.

## Git and releases

- Keep commits scoped to one architectural boundary or service.
- Do not use Git submodules. Directory history must remain filterable if a
  service later moves to a dedicated repository.
- Do not commit model weights, virtual environments, generated audio, secrets,
  production configuration, or server-specific files.
- Publish nothing until license, dependency, model, fixture, and secret reviews
  have passed.
- Release artifacts are immutable, versioned, and accompanied by checksums.
