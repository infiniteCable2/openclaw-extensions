# Production installation

The three runtime packages have independent installation boundaries. Build a
new immutable candidate beside the active release, validate it, then change
OpenClaw configuration in one reversible cutover.

## Order

1. Install and validate the accelerator broker and unprivileged lease runner.
2. Provision the pinned STT and TTS artifacts and build fresh service runtimes.
3. Create the private TTS voice catalog and verify `GET /v1/voices` exposes
   metadata only.
4. Build and install the OpenClaw plugin.
5. Validate an OpenClaw candidate configuration using accelerator `required`
   mode for both workers and `tts.auto: "inbound"`.
6. Stop superseded media workers, activate the candidate, and restart only the
   OpenClaw gateway. Exercise TTS, feed its synthetic output to STT, and prove
   both workers return to broker-confirmed standby after the idle lease.

Keep the previous OpenClaw configuration, plugin release, service runtimes,
artifacts, and broker unit definitions until the complete acceptance test has
passed. A failed readiness, inference, CUDA-backend, lease-renewal, or standby
check must restore the previous configuration and services. Never introduce a
CPU or cloud fallback for either local media worker.

Detailed package procedures:

- [STT installation](../services/stt/INSTALL.md)
- [TTS installation and voice catalog](../services/tts/INSTALL.md)
- [Accelerator installation](../services/accelerator/INSTALL.md)
- [OpenClaw plugin configuration](../packages/openclaw-local-media/README.md)

Models, wheels, reference audio, configuration containing private paths,
generated media, credentials, and deployment state are intentionally ignored
by Git. Store checksums and release provenance in the deployment inventory,
not in logs that could contain user content.
