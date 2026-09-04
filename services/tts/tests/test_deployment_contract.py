from __future__ import annotations

import hashlib
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_ROOT = SERVICE_ROOT / "deploy"


def test_chatterbox_runtime_reuses_the_proven_dependency_graph() -> None:
    runtime = (DEPLOY_ROOT / "requirements" / "chatterbox-runtime.txt").read_text(
        encoding="utf-8"
    )
    torch_profile = (
        DEPLOY_ROOT / "requirements" / "torch-chatterbox-cu124.txt"
    ).read_text(encoding="utf-8")
    constraints = (
        DEPLOY_ROOT / "requirements" / "constraints-debian-py313-cu124.txt"
    ).read_text(encoding="utf-8")

    assert "transformers==5.2.0" in runtime
    assert "diffusers==0.29.0" in runtime
    assert "safetensors==0.5.3" in runtime
    assert "gradio" not in runtime
    assert "https://download.pytorch.org/whl/cu124" in torch_profile
    assert "torch==2.6.0" in torch_profile
    assert "torchaudio==2.6.0" in torch_profile
    locked = [
        line.strip()
        for line in constraints.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert len(locked) == 99
    assert hashlib.sha256(("\n".join(locked) + "\n").encode()).hexdigest() == (
        "97ef81094b99a2f98e8764da5708b731c9f752d40ffda724c0df80a9ea7ee309"
    )
    assert "numpy==2.4.6" in locked
    assert "torch==2.6.0+cu124" in locked
    assert "torchaudio==2.6.0+cu124" in locked
    assert "voicecore" not in (runtime + torch_profile + constraints).lower()


def test_online_builder_keeps_exact_sources_and_installs_this_service() -> None:
    installer = (DEPLOY_ROOT / "chatterbox" / "build_runtime_online.sh").read_text(
        encoding="utf-8"
    )
    source_patch = DEPLOY_ROOT / "patches" / "chatterbox-source-runtime.patch"
    offline_patch = DEPLOY_ROOT / "patches" / "chatterbox-offline-tokenizer.patch"

    assert "5de7a54aa4e5e2baadb0182dde554908b48b85c2" in installer
    assert "ce86c49d029f42272c1902eccb675556b9ed2330" in installer
    assert "9bf5d845b5e043ffaf4657f4942939091c7697a2" in installer
    assert hashlib.sha256(source_patch.read_bytes()).hexdigest() in installer
    assert hashlib.sha256(offline_patch.read_bytes()).hexdigest() in installer
    assert installer.count('--constraint "${CONSTRAINTS_FILE}"') == 2
    assert '"${SERVICE_ROOT}"' in installer
    assert "openclaw-local-tts==0.1.0" in installer
    assert "/srv/openclaw/workers/venvs/tts-chatterbox-py313" in installer
    assert "/srv/openclaw/workers/vendor/chatterbox-5de7a54aa4e5-v2" in installer
    assert "voicecore" not in installer.lower()


def test_offline_installer_requires_a_hash_bound_local_service_wheel() -> None:
    installer = (
        DEPLOY_ROOT / "chatterbox" / "install_runtime_offline.sh"
    ).read_text(encoding="utf-8")

    assert "export PIP_NO_INDEX=1" in installer
    assert installer.count("--no-index") == 3
    assert installer.count("--only-binary=:all:") == 3
    assert "TTS_SERVICE_WHEEL_SHA256" in installer
    assert "OpenClaw TTS service wheel digest mismatch" in installer
    assert "openclaw-local-tts==0.1.0" in installer
    assert "git clone" not in installer
    assert "pip install --upgrade" not in installer
    assert "voicecore" not in installer.lower()


def test_model_and_source_artifact_defaults_are_neutral_and_pinned() -> None:
    model = (DEPLOY_ROOT / "chatterbox" / "model_artifact.py").read_text(
        encoding="utf-8"
    )
    source = (DEPLOY_ROOT / "chatterbox" / "source_artifact.py").read_text(
        encoding="utf-8"
    )

    assert "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18" in model
    assert "t3_mtl23ls_v3.safetensors" in model
    assert "/var/lib/openclaw/models/tts/chatterbox-multilingual-v3" in model
    assert "openclaw-model-manifest.json" in model
    assert "openclaw-source-manifest.json" in source
    assert "voicecore" not in (model + source).lower()
