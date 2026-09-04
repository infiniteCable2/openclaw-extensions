# TTS installation and voices

This production profile targets Debian 13, Python 3.13, NVIDIA CUDA 12.4, and
the pinned Chatterbox Multilingual v3 artifact. It has no CPU, alternate model,
cloud, or download-at-runtime fallback.

## Runtime and artifacts

For a connected reproducible build, run
`deploy/chatterbox/build_runtime_online.sh` as an unprivileged release user.
For production promotion, prefer the network-disabled
`deploy/chatterbox/install_runtime_offline.sh` with a fully verified pinned
wheelhouse and an explicitly SHA-256-bound wheel of this service. Both paths
refuse unsafe or reused targets.

Provision or adopt the model with `deploy/chatterbox/model_artifact.py`. Adopt
only its pinned data files, never another service's manifest. Vendor source
trees use `deploy/chatterbox/source_artifact.py`; the offline wheelhouse uses
`deploy/chatterbox/wheelhouse_artifact.py`. Run every verifier in full before
allowing OpenClaw to select the candidate.

## Service-owned voice catalog

Copy `deploy/voice-catalog.example.json` to a root-owned path such as
`/etc/openclaw-local-media/tts-voices.json`, replace the examples, validate it
against `contracts/local-media-v1/voice-catalog.schema.json`, and set mode
`0640` with the OpenClaw runtime group as reader. Reference audio belongs under
a private, non-Git state directory and must be an absolute, regular,
non-symlink file.

Each voice entry owns:

- a stable public `id` used by OpenClaw personas and requests;
- a display `name` plus optional locale and description;
- its private `reference_path`;
- optional Chatterbox `generation` values (`exaggeration`, `temperature`, and
  `cfg_weight`).

The worker validates the entire catalog before loading the model. Its bounded
`GET /v1/voices` response emits only id, name, locale, and description. It
never emits reference paths or generation values. Changing voice per request
does not reload the model; it switches only reference conditioning and the
validated generation values.

## OpenClaw ownership

Do not install a persistent TTS systemd unit. OpenClaw's `localService` owns
the worker and invokes the accelerator runner in `required` mode. The worker
portion is:

```text
/srv/openclaw/workers/venvs/tts-chatterbox-py313/bin/openclaw-local-tts
--model-path /var/lib/openclaw/models/tts/chatterbox-multilingual-v3
--chatterbox-source /srv/openclaw/workers/vendor/chatterbox-5de7a54aa4e5-v2
--perth-source /srv/openclaw/workers/vendor/perth-ce86c49d029f
--s3tokenizer-source /srv/openclaw/workers/vendor/s3tokenizer-9bf5d845b5e0
--voice-catalog /etc/openclaw-local-media/tts-voices.json
--host 127.0.0.1 --port 8020
```

Set `tts.auto: "inbound"` and `tts.mode: "final"`. This yields text only for a
text inbound and text plus synthesized speech for an audio inbound. A persona
may select one discovered public voice id; the TTS service remains the source
of truth for its actual voice material and tuning.

Acceptance requires public-catalog privacy, CUDA observation, successful Opus
synthesis, correct per-voice switching without a second model load, worker
termination after idle, lease release, and broker-confirmed standby.

## Rollback

Restore the previous OpenClaw configuration/plugin selection and restart the
gateway. Keep the old runtime, artifact set, and private voice directory until
acceptance is complete. Never solve a TTS failure by enabling CPU or cloud
fallback.
