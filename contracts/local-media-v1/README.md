# Local media contract v1

This directory owns the implementation-neutral contract between the native
OpenClaw plugin and local media services. `openapi.yaml` is the executable v1
HTTP contract.

The contract defines:

- separate liveness, readiness, and content-free status responses;
- bounded binary audio upload for transcription;
- bounded text input and binary audio output for synthesis;
- bounded request deadlines and cooperative cancellation, including queued work;
  a running model call may finish internally before the worker becomes available;
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

## Optional request lifecycle headers

Each STT/TTS request, including streaming synthesis, accepts these additive v1
headers:

- `X-OpenClaw-Request-Id`: a fresh, random UUIDv4. Never reuse a request ID or
  derive it from a user/session identity.
- `X-OpenClaw-Request-Timeout-Ms`: an integer from 1 to 300000. The service uses
  the shorter of this duration and its configured `--request-timeout-ms`
  (default 300000), measured with a monotonic clock from handler registration.
  Queue time, preparation, inference and encoding consume the same budget.

Omitting headers preserves existing clients, but the bounded default still
applies. Before stopping an obsolete request, clients send a best-effort
`POST /v1/requests/{requestId}/cancel` to the **same service** and abort the
original transport. Successful cancellation registration returns 204; it does
not imply a running GPU kernel has already stopped. This endpoint inherits the
loopback-only transport requirement. IDs are capabilities, not authorization
for remote exposure.

Cancellation is idempotent. Pre-arrival cancellation creates a five-minute
tombstone so a racing original request cannot start. Completed IDs remain
retired for five minutes; duplicates return 409. Registries cap active and
retired entries at 1024 and fail closed with 429 at capacity. State is local to
one worker process; no cross-service or restart-persistent identity is implied.

Admission is FIFO and bounded. Queued work checks cancellation/deadline every
50 ms and never starts stale inference. Safe checkpoints surround preprocessing,
each STT decoder/TTS segment, and codec processing; **GPU kernel preemption is
not provided**. A cancelled or expired active segment may finish internally, but
its output and remaining segments are discarded. Codec subprocesses are killed
and reaped on cancellation/deadline. WSGI close also releases resources even when
a streaming generator never started. Reserved HTTP thread headroom permits
health/cancel operations alongside the bounded inference queue.

Before response headers, cancellation is 409 (`cancelled`) and expiry is 408
(`deadline_exceeded`). STT SSE emits a terminal error record if headers are
already open; TTS PCM streaming ends unsuccessfully without its zero-length
success frame. These conditions must never be treated as successful empty media.

## Decoded audio and native PCM bounds

Transcription decodes incrementally to mono 16 kHz with a 900-second sample
budget for both ordinary audio files and agent-directed speech. Oversized
decoded input is rejected before the complete recording is materialized. Only
ordinary audio containers are allowed; playlist/concat and external protocol
resolution are disabled. Byte size and decoded duration are separate bounds.
This is a resource limit, not a speech/noise gate for ordinary attachments.

TTS bounds cumulative rendered PCM as well as encoded output. Native-rate PCM
is returned bit-exactly without an unnecessary ffmpeg resampling process.

## Optional transcription progress

`POST /v1/audio/transcriptions` keeps its JSON response by default. The optional
multipart field `stream=true` selects `text/event-stream`; `false` or omission
keeps JSON. Other field values are invalid. Request validation and bounded
admission happen before a streaming 200 response. This is not a separate VAD
service and does not change inference or filtering defaults.

Each SSE event is one `data: <JSON>` record followed by a blank line:

- `{ "type": "speech.confirmed" }` appears at most once, only after the
  enabled backend VAD retained a finite positive audio duration. Preparation,
  including any language detection, has already run; lazy text decoding has
  not started. This is a VAD decision, not a guarantee of a nonempty transcript.
- `{ "type": "transcript.done", "text": "...", "model": "..." }` is the
  sole successful terminal record, including when `text` is empty. It may
  include `recognition`, a bounded set of numeric observations. Durations and
  segment count are backend-neutral; signal names are backend-scoped. They are
  not calibrated confidence or a command to change capture gain. Consumers
  must tolerate their absence and unknown signal names.
- An inference failure in the opened stream produces the sole terminal record
  `{ "type": "error", "error": { "code": "inference_failed", "message":
"STT inference failed", "retryable": true } }`. HTTP status cannot be
  changed after streaming starts. Error details remain private.

A completed stream ends immediately after its terminal record. EOF without a
terminal record is cancellation or failure, never successful empty output.
Upload and admission ownership last until completion/disconnect, including an
unstarted response being closed. A synchronous model operation already running
may still finish before WSGI observes the disconnect; there is no background
inference thread or additional queue. Clients that do not request streaming
retain the original JSON/error-status behavior.
