# OpenClaw local STT service

Standalone OpenAI-compatible speech-to-text worker for the native
`local-media` provider. The production backend is Faster-Whisper on CUDA.

The process loads the model before opening its HTTP listener. `/ready` therefore
becomes reachable only after CUDA and the configured offline model are usable.
There is no CPU, cloud, alternate-model, or network-download fallback.

## Runtime contract

- `GET /live`: process liveness.
- `GET /ready`: model and requested-backend readiness.
- `GET /status`: content-free state and bounded queue depth.
- `POST /v1/audio/transcriptions`: OpenAI-compatible multipart upload.

The service accepts at most one active inference plus a bounded number of
waiting requests. It never logs audio or transcript content.

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
model tree using `openclaw-model-manifest.json`. Production starts must use its
`--verify-only --quiet` mode before acquiring the model service.
