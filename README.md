# OpenClaw Extensions

Native OpenClaw integrations and independently deployable local media
services.

The repository starts as one workspace so contracts, providers, and services
can evolve together during the first production cutover. Each service keeps an
independent package and dependency boundary, allowing it to move to its own
repository later without changing the OpenClaw provider contract.

## Planned packages

- `packages/openclaw-local-media`: native OpenClaw STT and TTS provider plugin.
- `contracts/local-media-v1`: versioned, implementation-neutral service
  contracts.
- `services/stt`: local speech-to-text runtime.
- `services/tts`: local text-to-speech runtime.
- `services/accelerator`: optional privileged accelerator lifecycle broker.

OpenClaw owns channels, agents, sessions, provider selection, request leases,
and user-visible outcomes. The services own only bounded media processing and
hardware-facing lifecycle operations.

Voicecore is a legacy source reference. It is not a runtime dependency, package
dependency, protocol name, service name, or deployment path of this repository.

## Development status

The repository currently establishes architecture and extraction boundaries.
Provider and service implementations are added only with contract tests and
without implicit CPU or cloud fallback.
