# MatrixRTC media bridge

This service is a narrow, fail-closed LiveKit media process for OpenClaw. It
does not log in to Matrix, own a Matrix session, select an agent, call STT/TTS,
or retain conversation data. The bundled OpenClaw Matrix plugin remains the
only owner of Matrix sync, identity, routing, and MatrixRTC membership.

The process exposes three local streams, plus an explicitly enabled video socket:

- stdin: generation-tagged signed little-endian PCM16 frames, 24 kHz, mono,
  sent to LiveKit;
- stdout: raw signed little-endian PCM16, 24 kHz, mono, received from LiveKit;
- a mode-0600 Unix control socket: newline-delimited JSON for the short-lived
  LiveKit token, the single allowed remote LiveKit identity, E2EE keys, output
  cancellation, and lifecycle events.
- an optional mode-0600 Unix video socket: bounded binary RGBA frames. This
  stream is separate from control and PCM, so image encoding cannot block audio.

Video is off unless the admitted agent's central
`talk.speech.agentProfiles.<agentId>.video.enabled` is true. The Matrix adapter
passes that same policy to the speech core and bridge. The bridge advertises
`video_frames: true`; an enabled adapter refuses an older bridge without this
capability. With video disabled, video publications are unsubscribed without
ending the audio call. Participant authorization and E2EE checks are identical
for audio and video; video never grants another participant access.

The optional `--video-socket` is paired with `start.video` containing
`interval_ms`, `max_dimension`, and `max_bytes`. Limits are validated before
copying frames (default 1,000 ms, 1,920 pixels per side, 16 MiB RGBA). Frames
larger than the configured source limits are dropped, not silently resized.
At most two video tracks from the admitted participant are processed. The SDK
decoder is continuously drained; one shared pending sample is allowed and
additional samples are dropped during backpressure. RGBA conversion runs on
the blocking pool, rotation is applied losslessly, and the host asynchronously
encodes PNG before handing the frame to the shared speech core. No additional
codec dependency is installed.

Each video record has a 32-byte big-endian header: `OCVF`, version 1, format 1
(RGBA), two zero reserved bytes, arrival timestamp in epoch milliseconds (u64),
width (u32), height (u32), session-local source number (u32), and payload length
(u32). Payload length must equal `width * height * 4`. Timestamps describe
host receipt, not an exact remote capture clock. Source numbers reveal no
participant or track identifiers. Unsubscription and session stop release
decoder tasks and sockets; the bridge retains no images.

Control messages use a mode-0600 Unix socket. Incoming audio is written as raw
PCM16 to stdout. Outgoing audio uses bounded binary frames on stdin: `OCAP`,
protocol version 1, three zero flag bytes, an unsigned 64-bit big-endian output
generation, an unsigned 32-bit big-endian payload length, and at most one 10 ms
PCM16 frame. A `clear_output` control message advances the generation and
flushes LiveKit's short source queue. Frames from older generations are then
discarded, which gives OpenClaw a real Barge-in boundary without reconnecting
the call.

`set_output_gate` accepts `normal`, `duck`, or `paused` and acknowledges with
`output_gate_set`. The early acoustic candidate ducks output to one quarter
amplitude; sustained activity pauses the current TTS generation without
discarding its stdin frames. A rejected candidate resumes that generation.
Only confirmed speech discards the TTS generation with `clear_output`. A single
playout owner applies gates and generation changes and acknowledges them after
the current capture call finishes. Reversible duck/pause never clears native
audio. PCM submission is paced at one 10 ms frame per interval, with no catch-up
burst after pauses or scheduler stalls. The proven 1,000 ms native queue setting
is retained without intentionally prefilling it; it is not a promise of the
SDK's maximum internal occupancy. Pending frames retain their
order across a false candidate, pause, empty transcript, and resume. Separate
bounded control and PCM queues allow cancellation while paused.

The SDK exposes no exact consumption cursor: already-submitted native audio
can finish before a reversible gate becomes audible. An acknowledgement means
the local owner applied the gate, not that a remote loudspeaker has stopped.
Native scheduler/network stalls can exceed the nominal 10 ms submission cadence.
Capture futures are never cancelled for reversible gates because PCM may have
been accepted before the completion callback. A native capture stalled for two
seconds fails the session closed; possibly accepted PCM is never retried or
replayed, and the source is not reused. Release validation must include
native-load and encrypted-call pause/resume tests; fake-sink tests establish
sample ownership and ordering, not a remote playout latency guarantee.
The initial `ready` event advertises `output_gate: true` and
`remote_audio_ready: true`. After an allowed remote audio track is subscribed,
the bridge emits `remote_audio_ready` separately. OpenClaw can wait for this
event before playing a precomputed greeting; it must not infer remote media
readiness from LiveKit connection or local-track publication alone. A host
requiring either capability rejects an older bridge before the call connects.

The first control message must be `start`. Exactly one remote participant is
accepted. An unexpected participant is fatal and closes the media
session. Tokens and keys are never accepted on the command line or written to
logs. The bridge never logs credentials, participant identities, room
identifiers, transcripts, or audio.

This process is intentionally not useful on its own. The Matrix channel must
validate the exact configured DM room and Matrix user, join the corresponding
MatrixRTC session with media-key management enabled, acquire a short-lived JWT
from the advertised authorization service, and then launch this bridge.

See `INSTALL.md` for a reproducible container build and deployment layout.
