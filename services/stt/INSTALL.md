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

Do not install a persistent STT systemd unit. OpenClaw's `localService` owns
the worker process and its idle lifetime. In accelerator `required` mode its
command is `openclaw-accelerator-run`, followed after `--` by:

```text
/srv/openclaw/workers/venvs/stt-faster-whisper-py313/bin/openclaw-local-stt
--model-path /var/lib/openclaw/models/stt/faster-whisper-large-v3-turbo
--host 127.0.0.1 --port 8010
```

Use `http://127.0.0.1:8010/ready`, a model-load-aware readiness timeout, and a
finite idle stop. Before cutover, verify the model manifest and Python package
lock. Acceptance requires a CUDA observation, a successful bounded
transcription, worker termination after idle, lease release, and
broker-confirmed standby.

## Rollback

Restore the previous OpenClaw configuration/plugin selection and restart the
gateway. Because the candidate runtime and model are installed beside the old
release, rollback does not modify or delete either artifact. Remove the failed
candidate only after collecting content-free diagnostics.
