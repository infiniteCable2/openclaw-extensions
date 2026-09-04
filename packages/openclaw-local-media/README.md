# OpenClaw local media plugin

This package registers one native media-understanding provider for STT and one
native speech provider for TTS. Both use the provider id `local-media`.

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
          args: ["serve"],
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
        voices: ["astrid", "nova"],
        localService: {
          command: "/absolute/path/to/openclaw-local-tts",
          args: ["serve"],
          healthUrl: "http://127.0.0.1:8020/ready",
          readyTimeoutMs: 300000,
          idleStopMs: 120000,
        },
      },
    },
  },
}
```

`voice` is the provider default. An OpenClaw TTS persona can override it with
`personas.<id>.providers.local-media.voice`; an explicit permitted per-request
override wins over the persona. The service maps these public voice ids to
operator-configured reference files and never accepts a reference path over the
provider request.

This preserves the agreed Matrix behavior: inbound text gets a text reply;
an inbound voice note is transcribed before the agent run and gets the normal
text reply plus a synthesized voice note.

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
    "--ttl-seconds", "90",
    "--renew-interval-seconds", "20",
    "--renewal-failure-grace-seconds", "20",
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
