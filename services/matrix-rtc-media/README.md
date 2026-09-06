# MatrixRTC media bridge

This service is a narrow, fail-closed LiveKit media process for OpenClaw. It
does not log in to Matrix, own a Matrix session, select an agent, call STT/TTS,
or retain conversation data. The bundled OpenClaw Matrix plugin remains the
only owner of Matrix sync, identity, routing, and MatrixRTC membership.

The process exposes three local streams:

- stdin: generation-tagged signed little-endian PCM16 frames, 24 kHz, mono,
  sent to LiveKit;
- stdout: raw signed little-endian PCM16, 24 kHz, mono, received from LiveKit;
- a mode-0600 Unix control socket: newline-delimited JSON for the short-lived
  LiveKit token, the single allowed remote LiveKit identity, E2EE keys, output
  cancellation, and lifecycle events.

Control messages use a mode-0600 Unix socket. Incoming audio is written as raw
PCM16 to stdout. Outgoing audio uses bounded binary frames on stdin: `OCAP`,
protocol version 1, three zero flag bytes, an unsigned 64-bit big-endian output
generation, an unsigned 32-bit big-endian payload length, and at most one 10 ms
PCM16 frame. A `clear_output` control message advances the generation and
flushes LiveKit's short source queue. Frames from older generations are then
discarded, which gives OpenClaw a real Barge-in boundary without reconnecting
the call.

The first control message must be `start`. Exactly one remote participant is
accepted. An unexpected participant or track is fatal and closes the media
session. Tokens and keys are never accepted on the command line or written to
logs. The bridge never logs credentials, participant identities, room
identifiers, transcripts, or audio.

This process is intentionally not useful on its own. The Matrix channel must
validate the exact configured DM room and Matrix user, join the corresponding
MatrixRTC session with media-key management enabled, acquire a short-lived JWT
from the advertised authorization service, and then launch this bridge.

See `INSTALL.md` for a reproducible container build and deployment layout.
