from __future__ import annotations

from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_ROOT = SERVICE_ROOT / "deploy"


def test_cuda_runtime_profile_reuses_the_proven_pins() -> None:
    active = (DEPLOY_ROOT / "requirements.txt").read_text(encoding="utf-8")
    faster = (DEPLOY_ROOT / "requirements" / "faster-whisper.txt").read_text(
        encoding="utf-8"
    )
    constraints = (DEPLOY_ROOT / "constraints-debian-py313-cu124.txt").read_text(
        encoding="utf-8"
    )
    installer = (DEPLOY_ROOT / "build_runtime.sh").read_text(encoding="utf-8")

    assert "requirements/faster-whisper.txt" in active
    assert "openai-whisper" not in active.lower()
    assert "faster-whisper==1.2.1" in faster
    assert "nvidia-cublas-cu12==12.4.5.8" in faster
    assert "nvidia-cudnn-cu12==9.1.0.70" in faster
    assert "nvidia-cuda-nvrtc-cu12" not in constraints
    assert "ctranslate2==4.8.1" in constraints
    assert "onnxruntime==1.28.0" in constraints
    assert "av==18.0.0" in constraints
    assert '--constraint "${CONSTRAINTS_FILE}"' in installer
    assert '--no-deps' in installer
    assert '"${SERVICE_ROOT}"' in installer
    assert 'EXPECTED_PYTHON_MINOR="3.13"' in installer
    assert 'if [[ "${EUID}" -eq 0 ]]' in installer
    assert "pip install --upgrade" not in installer
    assert "/srv/openclaw/workers/venvs/stt-faster-whisper-py313" in installer
    assert "voicecore" not in (active + faster + constraints + installer).lower()


def test_model_artifact_contract_is_neutral_and_revision_bound() -> None:
    artifact = (DEPLOY_ROOT / "model_artifact.py").read_text(encoding="utf-8")

    assert "dropbox-dash/faster-whisper-large-v3-turbo" in artifact
    assert "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf" in artifact
    assert "openclaw-model-manifest.json" in artifact
    assert "/var/lib/openclaw/models/stt/faster-whisper-large-v3-turbo" in artifact
    assert "voicecore" not in artifact.lower()
