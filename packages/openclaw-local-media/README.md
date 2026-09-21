# OpenClaw local media plugin

This package registers native batch and realtime-adapter STT capabilities plus
one native speech provider for TTS. All use the provider id `local-media`.

It will use OpenClaw's configured local-service lease mechanism instead of
starting or supervising workers itself. Channel behavior remains in OpenClaw:
Matrix voice notes are transcribed before the agent run, and
`tts.auto: "inbound"` adds speech only for audio-originated conversations.

Only explicit numeric HTTP(S) loopback URLs are accepted; even `localhost` is
rejected so host-file or DNS changes cannot redirect media. The plugin never
falls back to a LAN, cloud, or CPU service. STT uses OpenClaw's bounded OpenAI-compatible
transcription transport. TTS accepts at most 64 MiB of generated audio and does
not include upstream response bodies in errors.

## Build and install

```bash
pnpm install
pnpm --filter @infinitecable2/openclaw-local-media build
openclaw plugins install /absolute/path/to/packages/openclaw-local-media
```

Build before installing: OpenClaw intentionally does not run package install
scripts for third-party plugins.

## OpenClaw configuration

The absolute service commands below are placeholders for the separately
installed STT and TTS release artifacts. Readiness URLs must return a success
status only after the requested GPU model is ready.

```json5
{
  models: {
    providers: {
      "local-media": {
        baseUrl: "http://127.0.0.1:8010/v1",
        authHeader: false,
        localService: {
          command: "/absolute/path/to/openclaw-local-stt",
          args: [
            "--model-path",
            "/absolute/offline/stt-model",
            "--host",
            "127.0.0.1",
            "--port",
            "8010",
          ],
          env: {
            LD_LIBRARY_PATH: "/absolute/stt-venv/lib/python3.13/site-packages/nvidia/cublas/lib:/absolute/stt-venv/lib/python3.13/site-packages/nvidia/cudnn/lib",
          },
          healthUrl: "http://127.0.0.1:8010/ready",
          readyTimeoutMs: 300000,
          idleStopMs: 120000,
        },
      },
    },
  },
  tools: {
    media: {
      models: [
        {
          provider: "local-media",
          model: "faster-whisper",
          capabilities: ["audio"],
          maxBytes: 20971520,
          timeoutSeconds: 300,
        },
      ],
      audio: { enabled: true },
    },
  },
  tts: {
    auto: "inbound",
    mode: "final",
    provider: "local-media",
    providers: {
      "local-media": {
        baseUrl: "http://127.0.0.1:8020/v1",
        model: "chatterbox",
        voice: "astrid",
        localService: {
          command: "/absolute/path/to/openclaw-local-tts",
          args: [
            "--model-path",
            "/absolute/offline/tts-model",
            "--chatterbox-source",
            "/absolute/offline/chatterbox-source",
            "--perth-source",
            "/absolute/offline/perth-source",
            "--s3tokenizer-source",
            "/absolute/offline/s3tokenizer-source",
            "--voice-catalog",
            "/absolute/private/tts-voices.json",
            "--host",
            "127.0.0.1",
            "--port",
            "8020",
          ],
          healthUrl: "http://127.0.0.1:8020/ready",
          readyTimeoutMs: 300000,
          idleStopMs: 120000,
        },
      },
    },
  },
}
```

The plugin discovers available voice ids from the local service's bounded
`GET /v1/voices` response. Reference paths and voice-specific generation
settings are deliberately omitted from that response and remain private to the
service. `voice` is the provider default. An OpenClaw TTS persona can override it with
`personas.<id>.providers.local-media.voice`; an explicit permitted per-request
override wins over the persona. The service maps these public voice ids to
operator-configured reference files and never accepts a reference path over the
provider request.

This preserves the agreed Matrix behavior: inbound text gets a text reply;
an inbound voice note is transcribed before the agent run and gets the normal
text reply plus a synthesized voice note.

Live meeting transports can select `local-media` as their realtime
transcription provider. The adapter accepts OpenClaw's 8 kHz G.711 mu-law
meeting stream, detects speech endpoints, converts bounded audio batches to WAV in
memory, and submits it to the same local `/v1/audio/transcriptions` endpoint.
It keeps at most two audio batches queued and fails closed on overflow. Sensible
defaults are provided; a meeting integration may override `baseUrl`, `model`,
`language`, `speechRmsThreshold`, `speechOnsetMs`, `silenceMs`, `preRollMs`,
`minSpeechMs`, `maxUtteranceMs`, `requestTimeoutMs`, and
`maxQueuedUtterances` in its realtime provider configuration. `baseUrl` remains
mandatory and loopback-only.

`maxUtteranceMs` bounds each audio batch sent to STT, not the user's speaking
turn. Continuous speech crossing that limit keeps the same speech onset and
accumulates batch transcripts in FIFO order. `onPartial`, when provided,
receives the cumulative text; only an actual silence endpoint delivers one
`onTranscript` and its processing lifecycle. An audio-size boundary alone
never dispatches an agent turn or starts waiting audio. A silence-only final
batch still finalizes text recognized in earlier batches.

`minSpeechMs` gates the completed turn, not individual size-limited batches.
When that minimum exceeds the batch cap, initial audio still reaches STT in
bounded batches; partial callbacks wait until the minimum is reached. A turn
ending below the minimum discards collected text and any late batch results.

Audio queue limits and per-request deadlines remain unchanged. Accumulated
text is limited to the same 256 KiB UTF-8 budget as one STT response; overflow
fails visibly rather than dispatching a truncated turn. Close or any failed
batch discards unfinished text. Batch text is joined in order with spaces,
without overlap reconstruction or another VAD pass.

With OpenClaw's optional realtime `onProcessing` callback, the adapter requests
`stream=true` with `Accept: text/event-stream`. It reports a session-local
utterance ID at the accepted endpoint before queueing or acquiring a lease.
Only the STT service's positive neural-VAD `speech.confirmed` event can trigger
early processing feedback; RMS onset alone never confirms speech. Confirmations
from older speech generations are suppressed. A positive confirmation from an
earlier size-limited batch is retained for the same turn, but published only
after its actual silence endpoint while processing is still pending. The final
transcript carries that ID and precedes its
terminal processing notification. Empty, failed, and cancelled jobs also settle
exactly once; closing cancels all pending IDs synchronously.

The streaming response is incrementally bounded to 256 KiB, including framing,
and rejected on malformed/incomplete UTF-8, missing or duplicate terminal events,
or a request deadline. Backend error contents are never forwarded. Integrations
without `onProcessing` retain the JSON request/response and one-argument
transcript callback. Building this optional capability requires a matching
OpenClaw public SDK exposing `onProcessing` and transcript metadata; the original
2026.8.1 SDK does not contain those additive contracts.

Realtime transcription emits content-free JSON timing summaries through the
existing OpenClaw plugin logger at info level; no global debug mode or extra
provider configuration is needed. `local_media_stt_utterance` is emitted once
per completed, discarded, or failed audio batch. A `partial` outcome denotes a
completed size-limited batch, not a completed user turn. It separates `queueWaitMs`,
`acquireMs`, and `httpMs` (including response-body parsing), and reports
`endpointToTranscriptMs` only when a transcript is delivered. Unreached phases
are `null`. `endpointSilenceWallMs` is measured on a monotonic clock;
`trailingSilenceAudioMs` and `utteranceAudioMs` are audio durations. An input
pause alone does not end an utterance: the existing silence endpoint advances
when audio frames arrive, not when a wall-clock timer expires.

One `local_media_stt_input_summary` at close/failure aggregates packet count,
audio duration, largest packet and input gap, frame/loud-frame counts, longest
loud run, speech starts, endpoints, completed/dropped work, and outstanding
work at that instant. `elapsedMs` and `inputIdleMs` expose missing input even
when no utterance reached STT. Pending cancellation records may settle after
this closing snapshot. Counters are bounded and do not retain per-frame data.
Neither event contains audio, transcript text, URLs, exception messages, model
or participant identifiers. Logger failures never interrupt media handling.

Before an admitted incoming call is answered, OpenClaw can prepare the realtime
transcription provider and the exact agent-scoped TTS persona. The plugin uses
the same host-owned local-service leases for this readiness phase, so model
startup is deduplicated and both workers remain leased for the call. Live TTS
uses the service's framed PCM endpoint: each linguistic segment becomes
available to the meeting transport as soon as that segment finishes, while
voice-note synthesis keeps the complete-response path.

## Building against the host SDK

Development uses the public SDK generated by the sibling `openclaw` checkout
through a pnpm link. Clone the matching OpenClaw fork next to this repository,
install and build that checkout first, then run `pnpm install --frozen-lockfile`
here and the package's `check`, `test`, and `build` scripts. Imports still use
only public `openclaw/plugin-sdk/*` entrypoints; no host source is bundled.

The early speech-confirmation lifecycle is an additive SDK contract in this
fork. The older published SDK does not declare it and must not be used to
type-check this source. Runtime consumers that do not request processing events
retain JSON transcription, but early waiting audio requires the matching host
and STT service candidate. Install those together after validating all three.

## Accelerator modes

The accelerator is not an LLM/media provider and is not exposed as an agent
tool. Each worker may be deployed in exactly one explicit mode:

- `disabled`: the worker manages its already-available device directly.
- `required`: the worker must obtain and renew a lease from the external
  accelerator broker before loading the model; broker failure makes readiness
  fail closed.

There is intentionally no `auto` or best-effort mode. OpenClaw owns the worker
process lease; the worker and broker own hardware readiness and proven standby.

Required mode uses the standalone runner as the local-service command. The
real worker follows `--`; all paths are absolute and installed outside the
plugin package:

```json5
localService: {
  command: "/absolute/path/to/openclaw-accelerator-run",
  args: [
    "--consumer", "openclaw-stt",
    "--ttl-seconds", "300",
    "--renew-interval-seconds", "20",
    "--renewal-failure-grace-seconds", "20",
    "--broker-timeout-seconds", "60",
    "--",
    "/absolute/path/to/openclaw-local-stt",
    "--model-path", "/absolute/offline/model/path",
    "--host", "127.0.0.1",
    "--port", "8010",
  ],
  healthUrl: "http://127.0.0.1:8010/ready",
  readyTimeoutMs: 300000,
  idleStopMs: 120000,
}
```

OpenClaw's idle stop terminates the runner. The runner first terminates the
worker process group and only then releases its hardware lease. If acquisition
or renewal is not proven, no worker remains available and OpenClaw receives a
normal local-service readiness failure; no direct-worker fallback is attempted.

The STT CUDA wheel directories shown in `localService.env.LD_LIBRARY_PATH` are
part of the selected STT runtime release. They are required because
CTranslate2 loads cuBLAS and cuDNN lazily on the first inference. Keep the paths
release-specific and verify the libraries before selecting a candidate. Where
STT and TTS do not fit concurrently, give both services a short positive
`idleStopMs`; `0` disables idle termination.
