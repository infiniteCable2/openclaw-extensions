# TTS installation and voices

This production profile targets Debian 13, Python 3.13, NVIDIA CUDA 12.4, and
the pinned Chatterbox Multilingual v3 artifact. It has no CPU, alternate model,
cloud, or download-at-runtime fallback.

The optional KittenTTS 2 profile is only prepared, not installed by these
Chatterbox scripts. See [KITTEN_TTS2.md](KITTEN_TTS2.md) before creating a
separate dependency/model artifact set or selecting that backend.

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
`deploy/wheelhouse_artifact.py`. Run every verifier in full before
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
- an optional private `reference_text` transcript (mandatory for KittenTTS 2);
- optional Chatterbox `generation` values (`exaggeration`, `temperature`, and
  `cfg_weight`).

The worker validates the entire catalog before loading the model. Its bounded
`GET /v1/voices` response emits only id, name, locale, and description. It
never emits reference paths or generation values. Changing voice per request
does not reload the model; it switches only reference conditioning and the
validated generation values.

## OpenClaw ownership

In the original demand-only mode, do not install a persistent TTS systemd unit.
OpenClaw's `localService` owns
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

For the opt-in scheduled-owner mode, use the service-owned policy subscription
and local demand connector described in `services/accelerator/INSTALL.md`.
Only one owner may bind the TTS worker port. Verify the voice catalog and
reference-file access from the persistent owner's worker environment before
selection. Retain the original direct runner configuration as rollback.

Acceptance requires public-catalog privacy, CUDA observation, successful Opus
synthesis, correct per-voice switching without a second model load, worker
termination after idle, lease release, and broker-confirmed standby. Include a
long German sample that crosses the service's segment boundary: every source
word must remain represented, Chatterbox must prepare the selected reference
only once for the request, and the result must be one ordered audio object.
Also cover numbered lists, German abbreviations, clock times, and decimal
numbers; Syntok must keep their punctuation attached to the intended sentence.

Attachment delivery continues to use the complete-response endpoint. Live
transports use `/v1/audio/speech/stream`, whose binary frames preserve service-owned
linguistic segment boundaries across arbitrary HTTP chunking. Acceptance must
prove first-segment playback before later synthesis completes, ordered delivery,
bounded total audio, cancellation on barge-in, and rejection of a stream without
its terminal completion frame.

## Backend segment profiles

The selected backend owns its immutable segmentation profile. Chatterbox keeps
the previous 32-word target, 45-word/400-character hard limits and
320/180/80/60 ms paragraph/sentence/clause/fragment pauses. Kitten uses the same
hard budgets, a 130-character short-unit packing preference and
160/120/60/40 ms pauses. Short complete utterances are still rendered immediately.
Kitten reuses its pinned SDK's edge-silence trimming and 8 ms fade per external
unit; Chatterbox audio and voice generation settings are not changed.

An operator may select an absolute, regular non-symlink JSON file with
`--speech-profile /etc/openclaw-local-media/tts-speech-profile.json` in the chosen
worker command. The file uses the profile shape from
`contracts/local-media-v1/openapi.yaml`; see
`deploy/speech-profile.example.json`. It is validated before model loading.
Changes require a new worker generation, not hot polling or a client override.

The profile is returned by `/v1/capabilities` without any voice reference,
identity or deployment path. OpenClaw uses it for native streaming and complete
utterance planning; the service consumes a supplied plan without splitting it
again. Standalone HTTP clients keep Syntok boundary detection with the same
profile. Native and service packages must be promoted together. Before selection,
prove discovery and ordered prepared-plan rendering with the actual candidate
SDK, both buffered and PCM streaming, including stale generation, short greetings,
German lists/abbreviations/numbers, expression spans and cancellation.

## Rollback

Restore the previous OpenClaw configuration/plugin selection and restart the
gateway. Keep the old runtime, artifact set, and private voice directory until
acceptance is complete. Never solve a TTS failure by enabling CPU or cloud
fallback.
