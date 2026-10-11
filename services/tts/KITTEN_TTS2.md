# KittenTTS 2 preparation

Status: optional backend source and synthetic boundary tests, **not a selected
production backend**. Existing Chatterbox selection remains the default.
No Kitten weights, runtime dependencies, voices or generated audio are in Git.

## Reviewed upstream contract (2026-10-11)

- [SDK](https://github.com/KittenML/KittenTTS), reviewed package metadata: `kittenml` 0.9.4.
- [API](https://github.com/KittenML/KittenTTS/blob/main/docs/api.md).
- [Expression and language limitations](https://github.com/KittenML/KittenTTS/blob/main/docs/voices-and-expression.md).
- [GPU benchmarks](https://github.com/KittenML/KittenTTS/blob/main/docs/vllm.md).
- [Separate weight license](https://huggingface.co/KittenML/kitten-tts-2/blob/main/LICENSE.md).

The code is Apache-2.0; the weights use the Stellon Labs Community License.
Review the actual weight license and incorporated acceptable-use terms before
provisioning or distributing them. Commercial registration, revenue/funding
limits and attribution requirements are not the same as Apache-2.0. This
preparation does not bundle weights or accept license terms on an operator's behalf.

This is the 1.7B speech language model, not the old tiny ONNX model. Small
packed files on disk do not imply equally small resident GPU memory. No speed
or memory improvement over another TTS backend has been measured here.

## Provisioning gate

Build a **separate** offline environment and artifact set. Do not upgrade the
working Chatterbox environment or install floating dependencies on the server.
Before building, resolve and pin the SDK source commit/wheel hash, dependency
lock, selected HF revision, codec/tokenizer/speaker files and all file hashes.
The repository's current `main` documentation is research, not an immutable
deployment pin. No automatic model downloader is a valid installation plan.

The reviewed initial closure is now recorded in `deploy/kitten2/model-pins.json`:
SDK commit `8ed679c08e0976b236bd5d0dc4ec9ddd98b0da98`, Kitten revision
`f2eee74f4467855ad58fe16f1fb7b7df473263fd` and codec revision
`749d1c1a46eb10492095d68fbcf55691ccf137cd`. This is only the packed/default
decoder profile. The offline verifier accepts exactly `model/` with its pinned
files and `cache/` with a regular codec snapshot plus the exact `refs/main`
revision, no symlinks, shared caches, stock voices or implicit Whisper files.
Provisioning still requires the separately reviewed runtime dependency lock and
operator license decision. The verifier never downloads or accepts terms:

```sh
python3 deploy/kitten2/model_artifact.py --artifact-root /absolute/candidate-bundle --write-manifest
python3 deploy/kitten2/model_artifact.py --artifact-root /absolute/candidate-bundle
```

The second invocation independently hashes all bytes again. An existing manifest
cannot be overwritten by adoption. A manifest is not a CUDA readiness proof.

The default vocoder separately loads `s3gen_meanflow.safetensors` from
`ResembleAI/chatterbox-turbo`. Provision its reviewed revision and hashes into a
dedicated offline HF cache, not the shared user cache. The SDK's codec lookup
does not pass a revision itself: the provisioned cache and whole-artifact
manifest must pin the exact bytes. Offline mode deliberately fails if these
files are absent. Include this dependency's license in the review too.

Preserve the current voice id and normalized reference WAV through the private
operator catalog. Add the exact recording transcript as `reference_text`, not
as public voice metadata. Use one speaker and validate the documented 5–30 s
reference duration; prefer at least six seconds to avoid the codec repeating a
shorter reference internally. The backend refuses missing transcripts rather than
implicitly loading another Whisper model. Chatterbox-only `generation` settings
must be removed from a separately prepared Kitten catalog, never silently ignored.

The initial candidate uses mandatory CUDA/PyTorch, lossless `packed` weights,
stable sampling and `normalize=False`. The upstream written-text normalizer is
English-specific: test German numbers, dates, units and lists independently.
The service keeps its existing bounded linguistic segmentation and one PCM
result per unit; Kitten's internal splitter is disabled for these units to
avoid two owners for boundaries/pauses. This remains segment-level streaming,
not token-level streaming. Cancellation checkpoints discard the active unit
and prevent later units; there is no claim of GPU-kernel preemption.

After a reviewed offline artifact is provisioned, the optional entry point is:

```sh
openclaw-local-tts --backend kitten2 \
  --model-path /absolute/offline/kitten-model \
  --kitten-cache-dir /absolute/private/kitten-codec-cache \
  --voice-catalog /absolute/private/kitten-voices.json
```

This is an example, not a deployment command. Every catalog voice is warmed
before opening the listener, including lazy codec and speaker conditioning.
Parameters and buffers of the language model, codec and speaker encoder must
all be on CUDA; an implicitly loaded transcriber/alternative decoder is refused.
Use the existing accelerator-aware supervisor/lease binding; do not create a
second lease owner or permit CPU/network fallbacks. A whole-model worker may
be reaped by that existing owner when standby is requested.

## Expression contract

`GET /v1/capabilities` advertises the installed backend's supported controls.
Kitten currently advertises ten emotions, ten vocal events and emphasis.
**Whisper is false**: a hushed stock voice is not a documented whisper control
for an arbitrary cloned voice. Unsupported controls fail rather than being
advertised or simulated.

An opt-in request carries plain `input` and a separate `expression` plan:

```json
{
  "input": "Das freut mich sehr.",
  "model": "kitten-tts-2",
  "voice": "example_voice",
  "response_format": "pcm",
  "expression": {
    "emotion": "joyful",
    "parts": [
      { "text": "Das freut mich " },
      { "event": "laugh" },
      { "text": "sehr", "emphasis": true },
      { "text": "." }
    ]
  }
}
```

All text parts concatenate to the plain input exactly. Emphasis is a bounded
word/phrase, not a different answer; controls are bounded and kept atomic during
segmentation. Only the backend adapter renders Kitten markup. Controls cannot
cut a word, and rendered units have an explicit size bound. The same request
plan works with buffered Opus/WAV/PCM and framed PCM streaming. Unsupported
backends return 400 before inference. Ordinary calls without the field retain
their existing behavior. Native `[[tts:*]]` directives are not accepted as a
second backend command language.

## OpenClaw integration and remaining activation gates

The matching native-core candidate adds typed speech expression facts to the
existing shared message `voiceExpression` field and forwards them through the
canonical synthesis owners. Provider metadata follows the actually selected
model, including per-request overrides, not only its default configuration.
The provider uses no hot-path capability polling; candidate installation must
verify `/v1/capabilities` against that reviewed selected-model metadata.

This explicit structured-message slice is not an automatic emotion emitter for
every final response, commentary or greeting. Automatic RTC responses currently
remain ordinary speech: the native consult block callback only supplies text.
Do not advertise a functioning live-model expression feature until admitted
capabilities, exact output scope and structured facts cross that native boundary.
Continue at the canonical speech/delivery owners, not Matrix/RTC-specific parsers:

1. Provider admission reads bounded capability metadata once for that worker
   generation; invalidate it when model/worker selection changes. No hot-path
   polling or generic claims that every backend supports every emotion.
2. Exact admitted agent/channel policy explicitly opts into expression for live
   speech and/or voice-note replies. Default is off. Provider config identifies
   technical support, not permission to enable it globally.
3. Inject a bounded, deterministic list of the **intersection** of installed
   capabilities and that policy. Ask the model for a speech-only expression
   plan using the native structured delivery/voice fields, not raw directions
   inside visible text or a competing `[[tts:*]]` DSL.
4. Visible text remains the authoritative plain answer. Canonical speech facts
   carry the validated plan through commentary, final response and greeting,
   to the existing provider override boundary. Text mirroring never strips
   arbitrary brackets from ordinary messages, code, citations or user input.
5. Streaming plans need stateful incomplete-part buffering and generation
   fencing. Do not speak a partial event or duplicate an event after Barge-in.
   Disabled/unsupported/malformed controls are explicit non-successes, not
   silent substitutions or a provider fallback.

## Comparative measurement / acceptance

Use isolated ports and the existing broker-owned GPU lifecycle. Obtain approval
for real model provisioning, synthesis and resource tests before starting them.
Keep production and its latest validated rollback unchanged during comparison.

- Same voice recording/transcript, German corpus, output format and segmentation
  for both backends. Include brief replies, numbers/lists, longer replies and
  emotion/event cases; listen for omissions, repetition and speaker drift.
- Record cold readiness, warm first PCM/first playable Opus, total generation,
  RTF, median/p95, encoding time, allocated/reserved **and whole-process** VRAM,
  host RAM and the remaining budget with STT/embedding resident. Do not compare
  only disk size or CUDA tensor allocation.
- Run one worker first. Only attempt two independent workers if measured peak
  VRAM plus STT/embedding and reserve fit. Measure concurrent and serial latency
  and starvation; do not assume a second process shares weights or clone cache.
- Retain one worker if resource use is similar or concurrency worsens latency.
  Switch only after a meaningful measured latency benefit and voice quality
  acceptance; a requested improvement is not a measured result.

vLLM is a later optional comparison, not the initial default: upstream reports
higher VRAM use and a long initialization despite faster synthesis. Its subprocess
lifecycle and cache reservation also need the existing supervisor's accounting.
