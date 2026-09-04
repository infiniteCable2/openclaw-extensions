# OpenClaw local TTS service

Standalone OpenAI-compatible text-to-speech worker for the native `local-media`
provider. The production backend is Chatterbox Multilingual v3 on CUDA with one
explicitly configured reference voice.

The process loads the model before opening its HTTP listener. It has no CPU,
cloud, alternate-model, or network-download fallback. A fixed absolute ffmpeg
binary performs bounded Opus/WAV/PCM encoding; it is not discovered through
`PATH`.

## Runtime contract

- `GET /live`: process liveness.
- `GET /ready`: model and requested-backend readiness.
- `GET /status`: content-free state and bounded queue depth.
- `POST /v1/audio/speech`: OpenAI-compatible synthesis request.

Voice-note output is Ogg Opus. Telephony output is raw mono PCM16 at the
requested supported rate. The service never logs input text or generated audio.

## Development

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

The production Chatterbox, PyTorch CUDA, vendor source, model, and reference
artifacts are a separately pinned offline build. `deploy/` contains the proven
99-distribution Debian 13/Python 3.13/CUDA 12.4 lock, full wheelhouse/source/
model verifiers, the two reviewed Chatterbox runtime patches, a pinned online
artifact builder, and a network-disabled runtime installer. The offline
installer additionally requires an explicit SHA-256-bound wheel of this
service. Model weights, wheels, vendor trees, and voices remain outside Git and
must be provisioned before starting the service.

Each `--voice-reference` is a public voice id mapped to one absolute,
operator-controlled WAV file. The model is loaded once; the selected reference
changes per request:

```bash
.venv/bin/openclaw-local-tts \
  --model-path /absolute/offline/model/path \
  --chatterbox-source /absolute/chatterbox/source \
  --perth-source /absolute/perth/source \
  --s3tokenizer-source /absolute/s3tokenizer/source \
  --voice-reference astrid=/absolute/voices/astrid.wav \
  --voice-reference nova=/absolute/voices/nova.wav \
  --default-voice astrid
```
