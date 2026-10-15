# STT installation

This production profile targets Debian 13, Python 3.13, NVIDIA CUDA 12.4, and
the pinned `large-v3-turbo` artifact. It intentionally has no CPU, alternate
model, cloud, or download-at-runtime fallback.

## Build

Install OS prerequisites (`python3`, its venv module, compiler/runtime
libraries required by the pinned wheels, and the reviewed NVIDIA driver). Run
the build as an unprivileged release user from a clean service source tree:

```bash
STT_VENV_DIR=/srv/openclaw/workers/venvs/stt-faster-whisper-py313 \
  ./deploy/build_runtime.sh
```

Provision the model directly with `deploy/model_artifact.py`, or copy only the
five pinned model data files from an already verified artifact. Do not copy a
foreign manifest. Adopt and then fully verify the destination:

```bash
python3 deploy/model_artifact.py \
  --output-dir /var/lib/openclaw/models/stt/faster-whisper-large-v3-turbo \
  --write-manifest
python3 deploy/model_artifact.py \
  --output-dir /var/lib/openclaw/models/stt/faster-whisper-large-v3-turbo \
  --verify-only --quiet
```

The runtime and model directories should be root-owned and non-writable by the
OpenClaw account. Grant only traversal and read/execute access needed by the
worker.

## OpenClaw ownership

In the original demand-only mode, do not install a persistent STT systemd unit.
OpenClaw's `localService` owns the worker process and its idle lifetime. In
accelerator `required` mode its
command is `openclaw-accelerator-run`, followed after `--` by:

```text
/srv/openclaw/workers/venvs/stt-faster-whisper-py313/bin/openclaw-local-stt
--model-path /var/lib/openclaw/models/stt/faster-whisper-large-v3-turbo
--host 127.0.0.1 --port 8010
```

The pinned CUDA wheels keep their shared libraries inside the isolated virtual
environment. Declare those exact, release-specific paths through OpenClaw's
native `localService.env` field so CTranslate2 can load cuBLAS and cuDNN during
the first inference:

```json5
env: {
  LD_LIBRARY_PATH: "/srv/openclaw/workers/venvs/stt-faster-whisper-py313/lib/python3.13/site-packages/nvidia/cublas/lib:/srv/openclaw/workers/venvs/stt-faster-whisper-py313/lib/python3.13/site-packages/nvidia/cudnn/lib",
}
```

Do not use a system CUDA directory or a CPU fallback here. Both directories and
their expected sonames must be verified as part of the immutable runtime
artifact before selection.

Use `http://127.0.0.1:8010/ready`, a model-load-aware readiness timeout, and a
finite idle stop. Before cutover, verify the model manifest and Python package
lock. Acceptance requires a CUDA observation, a successful bounded
transcription, worker termination after idle, lease release, and
broker-confirmed standby.

When scheduled accelerator standby is enabled, keep the existing positive
`idleStopMs` and add `localService.idleStopCheck` with the absolute
`openclaw-accelerator-idle-check` executable and fixed `--socket-path` and
`--accelerator-id` arguments. The broker's unload wish gates the stop only
after OpenClaw's existing idle interval. Apply the same setting to TTS.

For the opt-in scheduled-owner mode, use the service-owned policy subscription
and local demand connector described in `services/accelerator/INSTALL.md`.
Only one owner may bind the STT worker port. Preserve the pinned CUDA library
environment on the persistent owner unit, which launches the worker; putting
it solely on the OpenClaw demand connector is insufficient. Verify daytime
preload, night unload, an inbound night request, and broker outage behavior
before switching production.

For realtime agent-directed speech, set the local-media realtime provider's
`speechProcessorPython` to
`/srv/openclaw/workers/venvs/stt-faster-whisper-py313/bin/python`.
The plugin verifies this pinned WebRTC audio processor during call preparation
and starts an isolated process for each admitted conversation. This processor
is CPU-light signal processing, not a second STT model and not a GPU lease;
the normal STT worker still owns model readiness and inference. Leave the
setting absent until the revised OpenClaw SDK and plugin release are installed
and a rollback is prepared.

If STT and TTS cannot coexist in GPU memory, configure a very short positive
`idleStopMs` for both local services. A value of `0` means no idle stop in the
current OpenClaw lifecycle implementation and must not be used for that policy.

## Bounded inference and response delivery

The service has one model inference slot. Admission is FIFO for a complete
uploaded utterance, including its speech frontend and decoder lifetime; yielded
Whisper segments are not independently resumable scheduling units. Existing
upstream audio-batch/turn aggregation is unchanged.

Streaming responses use a lazy producer and an ordered SSE mailbox. A
`speech.confirmed` event can reach the client while decoding continues, but a
slow HTTP consumer never holds the model after decoding completes. Each response
is bounded to 256 events and 1 MiB of encoded event data plus one terminal error;
exceeding either limit fails closed. No transcript or audio is logged.

`max_queued_requests + 1` bounds the whole admitted request lifetime, including
responses still being drained, and therefore bounds producer threads and pending
response memory. `/status` `activeRequests` and `queueDepth` describe model
computation, not completed responses waiting for their consumer.
`inFlightRequests` counts all reserved request lifetimes. A disconnect
cancels cooperatively; request capacity and temporary files remain owned until
the running decoder actually retires. There is no additional GPU worker or
per-segment decoder preemption.

## Rollback

Restore the previous OpenClaw configuration/plugin selection and restart the
gateway. Because the candidate runtime and model are installed beside the old
release, rollback does not modify or delete either artifact. Remove the failed
candidate only after collecting content-free diagnostics.
