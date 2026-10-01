# OpenClaw local STT service

Standalone OpenAI-compatible speech-to-text worker for the native
`local-media` provider. The production backend is Faster-Whisper on CUDA.

The process loads the model before opening its HTTP listener. `/ready` therefore
becomes reachable only after CUDA and the configured offline model are usable.
There is no CPU, cloud, alternate-model, or network-download fallback.

This CUDA requirement applies to Whisper transcription. Faster-Whisper's optional
Silero VAD is separate preprocessing within the same worker: its ONNX model runs
on the CPU, even when Whisper uses CUDA. The worker enables that filter by default.
Pass `--no-vad-filter` when CPU neural inference is not allowed or when the caller
already provides reliably speech-segmented audio. Disabling the filter does not
move VAD onto CUDA; the upstream capture pipeline must still reject noise and
silence. No separate VAD service is started.

## Runtime contract

- `GET /live`: process liveness.
- `GET /ready`: model and requested-backend readiness.
- `GET /status`: content-free state and bounded queue depth.
- `POST /v1/audio/transcriptions`: OpenAI-compatible multipart upload.

The service accepts at most one active inference plus a bounded number of
waiting requests. It never logs audio or transcript content.

Requests explicitly marked `X-OpenClaw-Speech-Input: agent-speech` run a
conservative WebRTC Audio Processing Module pass (high-pass, noise suppression,
and gain limiting) after admission and before Faster-Whisper. Ordinary audio
files and media relays are not marked or altered. Acoustic echo cancellation is
disabled here: the server does not have a synchronized speaker reference from
the caller's device. Device-side capture should own AEC. The service requires
the pinned WebRTC binding at startup; a missing processor never silently falls
back to unprocessed agent speech.

The same installed runtime also exposes an internal per-call module,
`python -m openclaw_local_stt.speech_stream`, for realtime clients. Its binary
protocol is an `APM2` readiness marker followed by ordered 20 ms mono PCM16
frames at 16 kHz; each input frame yields one output frame followed by two
little-endian float32 values: speech probability and applied AGC gain in dB. The caller
owns process lifetime and a bounded input queue. This module is not a network
endpoint, is not shared between callers, and must never be placed on a
recording or media-relay path.

Each Faster-Whisper request emits one content-free info record with event
`local_media_stt_backend` through the existing service logger. `durationMs`
and `durationAfterVadMs` report the library's input and retained-audio durations;
`segmentCount` counts yielded decoder segments, including empty ones. Together
with `vadEnabled` and the `transcribed`/`empty`/`failed` outcome, these distinguish
audio removed by VAD from retained audio that produced no transcript. Invalid
or unavailable duration metadata is `null`.

`prepareMs` measures the synchronous `WhisperModel.transcribe` call, including
audio loading, VAD, feature preparation and any eager language/model work.
`decodeMs` measures consuming its lazy segment iterator and collecting text.
Neither is a pure VAD, CPU or GPU benchmark. `totalMs` covers both phases, but
not HTTP admission or the service queue. All use a monotonic clock. No text,
audio, paths, model IDs or exception values are included; diagnostics are
best-effort and do not change the JSON response or inference failure handling.

Realtime callers may send multipart `stream=true` to the same transcription
endpoint. It responds with data-only SSE JSON: an optional `speech.confirmed`
after enabled Faster-Whisper VAD retained finite positive audio, followed by
one `transcript.done` (also for empty text) or a fixed `error` event, then EOF.
The terminal event additionally carries optional `recognition` observations:
input and post-VAD duration, segment count, and up to eight finite, aggregated
backend-scoped numeric signals. Faster-Whisper currently reports segment means
for `avgLogProbability`, `noSpeechProbability`, and `compressionRatio` when
available. These are decoder diagnostics, not calibrated confidence; no raw
segments, text, or device identity are retained in this evidence object. Other
STT backends may omit the object or report their own vetted numeric signals.
The ordinary JSON response remains OpenAI-compatible and unchanged. No gain
control is driven by these observations yet.
Preparation includes feature extraction and possible language detection;
confirmation is before consuming the lazy text decoder, not an immediate
low-cost callback directly inside VAD. Disabled VAD never claims confirmation.
This lets a caller begin waiting audio while text decoding is still pending.

JSON and SSE share one inference implementation. Admission remains bounded and
held through stream completion/close. Closing an unstarted response also
releases its upload and admission. Disconnect does not preempt synchronous
GPU work already in progress; cleanup follows when the WSGI iterator closes.
Cancelled streams report diagnostic outcome `cancelled`, with `decodeMs=null`
when decoding never started. `totalMs` can include streaming backpressure and
is not pure model runtime. The optional wire contract is specified in
`contracts/local-media-v1`; omitted/false `stream` preserves JSON and its error
statuses. No VAD thresholds, default settings, worker threads or model calls
are added by this transport option.

## Development

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

For the Debian 13 CUDA production build, install the `cuda` extra into a fresh
service venv and point `--model-path` at a pre-provisioned, hash-verified model
directory:

```bash
.venv/bin/pip install -e '.[cuda]'
.venv/bin/openclaw-local-stt \
  --model-path /absolute/offline/model/path \
  --host 127.0.0.1 \
  --port 8010
```

`deploy/` preserves the proven Debian 13/Python 3.13/CUDA 12.4 dependency
graph and the exact `large-v3-turbo` model revision. `build_runtime.sh` refuses
root, existing targets, paths inside the service source, and other Python
minor versions. `model_artifact.py` provisions or fully verifies the offline
model tree using `openclaw-model-manifest.json`. An already verified legacy
artifact can be copied as data files only and adopted with `--write-manifest`;
foreign manifests must not be copied. Production starts must use its
`--verify-only --quiet` mode before acquiring the model service.
