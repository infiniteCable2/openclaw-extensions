# OpenClaw local TTS service

Standalone OpenAI-compatible text-to-speech worker for the native `local-media`
provider. The production backend is Chatterbox Multilingual v3 on CUDA with a
service-owned catalog of explicitly configured reference voices.

The process loads the model before opening its HTTP listener. It has no CPU,
cloud, alternate-model, or network-download fallback. A fixed absolute ffmpeg
binary performs bounded Opus/WAV/PCM encoding; it is not discovered through
`PATH`.

## Runtime contract

- `GET /live`: process liveness.
- `GET /ready`: model and requested-backend readiness.
- `GET /status`: content-free state and bounded queue depth.
- `GET /v1/voices`: public voice ids and descriptions, never private paths or
  generation settings.
- `POST /v1/audio/speech`: OpenAI-compatible synthesis request.

Voice-note output is Ogg Opus. Telephony output is raw mono PCM16 at the
requested supported rate. Syntok disambiguates German and English sentence and
paragraph boundaries without a model or accelerator allocation. The service
then bounds long sentences at clause or word boundaries before they reach
Chatterbox's approximately 40-second single-generation ceiling. All segments
retain one request's selected voice, are synthesized in order, joined as PCM
with bounded pauses, and encoded once.
The backend exposes the ordered segment iterator needed by a future streaming
transport; this endpoint deliberately remains one complete response for Matrix
and other attachment-style channels. The service never logs input text or
generated audio.

## Development

```bash
python3.13 -m venv .venv
.venv/bin/pip install -e '.[test]'
.venv/bin/pytest
```

The production Chatterbox, PyTorch CUDA, vendor source, model, and reference
artifacts are a separately pinned offline build. `deploy/` contains the proven
100-distribution Debian 13/Python 3.13/CUDA 12.4 lock, full wheelhouse/source/
model verifiers, the two reviewed Chatterbox runtime patches, a pinned online
artifact builder, and a network-disabled runtime installer. The offline
installer additionally requires an explicit SHA-256-bound wheel of this
service. Model weights, wheels, vendor trees, and voices remain outside Git and
must be provisioned before starting the service.

An existing verified model may be copied as its pinned data files only and
adopted with `model_artifact.py --write-manifest`; foreign manifests must not
be copied. The pinned file set and full digests are checked before the neutral
manifest is accepted.

The production interface is a root/operator-controlled voice catalog following
`contracts/local-media-v1/voice-catalog.schema.json`. Each entry maps a public
voice id to a private absolute WAV file and may carry Chatterbox generation
settings. The model is loaded once; the selected reference and settings change
per request:

```bash
.venv/bin/openclaw-local-tts \
  --model-path /absolute/offline/model/path \
  --chatterbox-source /absolute/chatterbox/source \
  --perth-source /absolute/perth/source \
  --s3tokenizer-source /absolute/s3tokenizer/source \
  --voice-catalog /etc/openclaw-local-media/tts-voices.json
```

Direct `--voice-reference` arguments remain available for development. Use the
catalog in production so voice knowledge remains in the service and OpenClaw
can discover it without learning private file locations. See `INSTALL.md`.
