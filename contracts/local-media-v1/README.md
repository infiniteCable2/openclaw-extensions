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
  sole successful terminal record, including when `text` is empty.
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
