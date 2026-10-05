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
- `POST /v1/requests/{requestId}/cancel`: cooperative request cancellation.

The service accepts at most one active inference plus a bounded number of
waiting requests. It never logs audio or transcript content.

Optional `X-OpenClaw-Request-Id` (random UUIDv4) and
`X-OpenClaw-Request-Timeout-Ms` headers bind queued and active work to one bounded
request. `--request-timeout-ms` defaults to 300000 and caps caller budgets.
Cancellation skips stale queued inference and stops at safe decode checkpoints;
it cannot preempt a running GPU kernel. See `contracts/local-media-v1` for
idempotent pre-arrival cancellation, expiry/error status, and registry bounds.
HTTP thread headroom is reserved beyond the configured inference queue.

Both ordinary attachments and marked agent speech are incrementally decoded
under a 900-second decoded-sample limit. This prevents highly compressed long
uploads from being fully decoded before rejection. Playlist/concat demuxers and
external protocol resolution are disabled. Ordinary attachments still receive
no speech-only enhancement or extra capture gate.

Requests explicitly marked `X-OpenClaw-Speech-Input: agent-speech` run a
conservative WebRTC Audio Processing Module pass (high-pass, noise suppression,
and gain limiting) after admission and before Faster-Whisper. Ordinary audio
files and media relays are not marked or altered. Acoustic echo cancellation is
disabled here: the server does not have a synchronized speaker reference from
the caller's device. Device-side capture should own AEC. The service requires
the pinned WebRTC binding at startup; a missing processor never silently falls
back to unprocessed agent speech.

Live speech and marked uploads share one `SpeechProcessor`: HPF and NS precede
one adaptive WebRTC AGC2, all at the native 10-ms cadence. The outer live wire
still uses 20-ms frames. The public bindings are composed to expose headroom
and gain/noise limits; no second independent feedback AGC or additional neural
VAD is run. NS probability is passed explicitly to AGC2, including uncertain
values; only all-zero input is marked as zero speech evidence.
Defaults are 12 dB maximum gain, 8 dB headroom, 6 dB/s native symmetric slew,
and a -50 dBFS estimated output-noise limit. These are native control settings,
not guarantees of measured SNR or of background-noise rejection. Slowing the
symmetric slew also slows attenuation during sudden noise, so the native
6 dB/s rate is retained. The limiter remains responsible for overload.

AGC2 is the only gain owner. Its native estimator uses speech evidence, noise
level and headroom to adjust gain over time, while its limiter protects peaks.
There is no service-level speech ceiling, uncertainty timer or second gain
multiplier. A model-free sweep of -50 through -30 dBFS used identical quiet
voice before/after a 90-second loud balcony-noise pause. Relaxing the limit to
-40 raised average native gain after the pause from 0 to +2.5 dB, but also
raised noise-only output and did not increase the live gate's accepted speech
fraction. The conservative -50 dBFS limit therefore remains the default.
This does **not** improve the physical input SNR, guarantee STT recognition or
replace STT/VAD confirmation. Further tuning needs call-level evidence.

The pinned `pywebrtc-audio==0.2.0` binding hardcodes a 15 dB initial gain even
when the maximum is lower. Startup advances only the gain stage through
bounded silent frames to settle to the configured ceiling before processing
user PCM. This introduces no wall-clock wait, does not prime the noise
estimator, and discards no user samples. Revalidate this adaptation when
upgrading the binding. Internal `SpeechControlConfig` bounds these settings;
there is no new HTTP or OpenClaw configuration surface.

The same installed runtime also exposes an internal per-call module,
`python -m openclaw_local_stt.speech_stream`, for realtime clients. Its binary
protocol is an `APM4` readiness marker followed by ordered 20 ms mono PCM16
frames at 16 kHz; each input frame yields one 640-byte output frame followed by
8 little-endian float32 values (32 bytes). In order: latest native 10-ms speech
probability, applied block gain in dB, pre-gain cleaned RMS, then counts of
10-ms high/mid/low-probability frames, input-clipped frames and input-muted
frames. The three probability buckets sum to two;
clipped means at least 1% of received samples at 99.9% full scale, muted means
all-zero input. These last two counters help explain conservative control,
not identify a speaker or classify sound conclusively. Old `APM3` workers are
rejected at readiness; deploy and roll back the matched plugin/service pair.

Gain is measured from aligned pre-/post-AGC squared energy
over the complete 20-ms frame, including limiter action, rather than the
binding's potentially stale last-10-ms peak ratio. It does not invert NS or
reconstruct the original microphone signal. The caller
owns process lifetime and a bounded input queue. This module is not a network
endpoint, is not shared between callers, and must never be placed on a
recording or media-relay path.

Control observations do not change processing decisions. The plugin retains
only bounded per-call aggregates in its existing log; the worker writes no
per-frame log, audio recording or separate diagnostic store. Reported gain is
the aligned clean-to-output energy ratio, including native limiter action.
Raw, cleaned and output levels have distinct meanings; none is a physical SNR
measurement or the original hardware microphone level.

Each Faster-Whisper request emits one content-free info record with event
`local_media_stt_backend` through the existing service logger. `durationMs`
and `durationAfterVadMs` report the library's input and retained-audio durations;
`segmentCount` counts yielded decoder segments, including empty ones. Together
with `vadEnabled` and the `transcribed`/`empty`/`failed` outcome, these distinguish
audio removed by VAD from retained audio that produced no transcript. Invalid
or unavailable duration metadata is `null`.

`prepareMs` measures bounded audio loading and the synchronous
`WhisperModel.transcribe` call, including VAD, feature preparation and any eager
language/model work.
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
statuses. No VAD thresholds or additional model calls are added by this transport
option.

## Development

### Model-free control comparison

From this repository root, with the pinned native binding installed:

```bash
services/stt/.venv/bin/python services/stt/tools/compare_speech_control.py --synthetic-noise \
  | node services/stt/tools/compare_speech_gate.mjs
```

Use a current Node runtime with native TypeScript stripping (22.18+ or 24+).
Repeat `--input /path/to/consented.wav` for up to 32 mono 16-kHz PCM16 WAVs,
each at most 60 seconds. The probe emits only numeric evidence and anonymous
case labels, not media, filenames, transcripts or paths. It uses no model or
server. Both APM variants feed the **current** TypeScript gate with its coded
default thresholds: this isolates the APM change, not an old/new full-system
or production-configuration comparison. Optional `--headroom-db` and
`--slew-db-per-second` and `--noise-limit-dbfs` affect only the candidate in
this offline probe.
Use `--level-transitions` with an input to additionally replay a bounded excerpt
at quiet/loud/quiet peak scales 0.05/0.98/0.05. Both native processors and gates
retain their state across these phases. This deliberately extreme 26-dB switch
tests recovery, not typical recording loudness. A low speech-probability result
after the switch can originate in NS in both variants; gain changes alone
cannot repair that classification.
In the local extreme transition replay, both variants gave very little speech
evidence in the final quiet phase. This remains a detector/recovery validation
gap, not a passing end-to-end recognition result. No CUDA transcription or live
call was exercised by this model-free probe.

In the local native-only replay with six noise-only recordings, one silence
recording and seven speech recordings, the real capture gate accepted zero
frames from all seven non-speech controls. Against the existing combined-binding
baseline, speech accepted-frame fractions were equal in six cases and differed
by 0.05 percentage points in one. This is capture-gate evidence, not word-error
rate or live barge-in validation.
The four synthetic 26-dB noise-step cases still produced 1.46–2.38-second
speech-candidate bursts in **both** variants. Spectral probability and energy
alone do not prove speech; preserve the subsequent VAD/STT confirmation and
reversible interruption behavior. Do not tune a blanket rejection threshold
to these few recordings or describe this controller as a clean-source SNR
estimator.

`tools/trace_speech_control.py` provides a separate 20-ms numerical timeline
from a consented voice WAV and optional background WAV, without recording media
or invoking a model. `--noise-limit-dbfs` varies only the native AGC2 setting;
`--summary` returns phase averages. Pipe its default JSONL into
`tools/trace_speech_gate.mjs` to measure the actual live gate, and optionally
render that numeric result with `tools/plot_speech_trace.mjs`. The matched
before/after quiet-voice phases deliberately reuse identical samples across a
90-second loud-noise pause; they test state recovery, not intelligibility.

### Offline noise/level matrix

`tools/offline_noise_matrix.py` exercises the same APM configuration as live
calls and marked voice messages, followed by Faster-Whisper's bundled Silero
VAD. It mixes a supplied **synthetic** 16-kHz mono PCM16 voice WAV with seeded
white, road-like, wash-like and impact noise at configurable voice levels and
SNRs. Every mixture has a matching noise-only control. The default matrix has
60 mixtures from -20 to +20 dB SNR and -40 to -12 dBFS voice level. It prints
only numeric input/output level, clipping, WebRTC probability/gain and retained-VAD
duration; no audio or transcript is written by the evaluator.

On Windows with an installed German offline SAPI voice:

```powershell
New-Item -ItemType Directory -Force build | Out-Null
& powershell.exe -NoProfile -File tools/synthesize-test-voice.ps1 -OutputPath build/test-voice.wav
& .venv/Scripts/python.exe tools/offline_noise_matrix.py build/test-voice.wav
```

On other systems, supply an independently synthesized WAV in the same format.
The optional `--model-path /absolute/local/cuda/model --expected 'spoken words'`
also tests word error rate through the local CUDA Faster-Whisper decoder. It
never downloads a model or falls back to CPU/cloud inference. Without those
two arguments, the evaluator explicitly reports `decoderTested: false`:
retained VAD audio is not proof that words were understood. Clipping-heavy
extremes are stress cases, not target operating conditions. This synthetic
matrix cannot replace a real call in the problematic environment.

Add `--paired` to report **raw and APM on the same mixtures** rather than
only the configured APM path. Noise-only VAD duration is measured in both
arms. With a model, compare paired WER case by case and repeat difficult cases;
without a model, `wer: null` means that the result measures acoustic/VAD
behavior only. This flag does not alter the production speech processor.
For a short, consented 16-kHz mono PCM16 recording, use `--direct` to compare
the unchanged input with APM without adding synthetic noise. It reports no
audio, path or transcript; omit `--expected` when there is no authorized local
CUDA decoder. Direct recordings are bounded to 60 seconds; the synthetic
matrix retains its 20-second input bound. Keep test recordings outside Git
and remove them according to the agreed retention policy.

The local-media plugin also has an opt-in cross-language worker test. Run it
with `OPENCLAW_STT_REPLAY_PYTHON` set to the absolute Python executable from
an installed STT test environment and with that environment's `src` directory
on `PYTHONPATH`. It checks the actual 20-ms APM wire protocol without loading
the CUDA model or contacting a service. Ordinary plugin tests use deterministic
APM evidence to exercise gate, endpoint and packet-fragmentation behavior.
From the repository root, after building that plugin,
`node packages/openclaw-local-media/tools/replay-live-speech.mjs <wav> [full|first5|last5]`
replays a consented WAV through the actual native worker and provider gate.
The tool intercepts STT requests in memory and emits only content-free counts
and levels; it cannot measure recognition quality. Five-second regions are
separate processor sessions, so the `last5` check does not preserve the gain
history of the full call.

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
