# OpenClaw Extensions

Native OpenClaw integrations and independently deployable local media
services.

The repository starts as one workspace so contracts, providers, and services
can evolve together during the first production cutover. Each service keeps an
independent package and dependency boundary, allowing it to move to its own
repository later without changing the OpenClaw provider contract.

## Components

- `packages/openclaw-local-media`: native OpenClaw STT and TTS provider plugin
  (implemented and unit-tested).
- `contracts/local-media-v1`: versioned, implementation-neutral service
  contract (OpenAPI).
- `services/stt`: local speech-to-text runtime (implemented and contract-tested).
- `services/tts`: local text-to-speech runtime (implemented and contract-tested).
- `services/accelerator`: optional fail-closed lease runner and narrow
  Linux/PCI/NVIDIA lifecycle broker (implemented and contract-tested).
- `contracts/accelerator-v1`: versioned Unix-socket lease and broker
  configuration contracts.

OpenClaw owns channels, agents, sessions, provider selection, request leases,
and user-visible outcomes. The services own only bounded media processing and
hardware-facing lifecycle operations.

Voicecore is a legacy source reference. It is not a runtime dependency, package
dependency, protocol name, service name, or deployment path of this repository.

## Development status

The native provider layer, standalone STT/TTS services, accelerator lease
runner, and hardware-specific broker are implemented. None of the services is
production-deployed from this repository yet. Service implementations are
added only with contract tests and without implicit CPU or cloud fallback.
