# MatrixRTC media bridge

This service is a narrow, fail-closed LiveKit media process for OpenClaw. It
does not log in to Matrix, own a Matrix session, select an agent, call STT/TTS,
or retain conversation data. The bundled OpenClaw Matrix plugin remains the
only owner of Matrix sync, identity, routing, and MatrixRTC membership.

The process exposes three local streams:

- stdin: raw signed little-endian PCM16, 24 kHz, mono, sent to LiveKit;
- stdout: raw signed little-endian PCM16, 24 kHz, mono, received from LiveKit;
- a mode-0600 Unix control socket: newline-delimited JSON for the short-lived
  LiveKit token, the single allowed remote LiveKit identity, E2EE keys, and
  lifecycle events.

The first control message must be `start`. Exactly one remote participant is
accepted. An unexpected participant or track is fatal and closes the media
session. Tokens and keys are never accepted on the command line or written to
logs.

This process is intentionally not useful on its own. The Matrix channel must
validate the exact configured DM room and Matrix user, join the corresponding
MatrixRTC session with media-key management enabled, acquire a short-lived JWT
from the advertised authorization service, and then launch this bridge.

See `INSTALL.md` for a reproducible container build and deployment layout.
