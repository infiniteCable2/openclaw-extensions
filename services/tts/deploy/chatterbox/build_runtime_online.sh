#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
SERVICE_ROOT="$(cd -- "${DEPLOY_ROOT}/.." && pwd)"
VENV_DIR="${TTS_VENV_DIR:-/srv/openclaw/workers/venvs/tts-chatterbox-py313}"
CHATTERBOX_REPO_DIR="${CHATTERBOX_REPO_DIR:-/srv/openclaw/workers/vendor/chatterbox-5de7a54aa4e5-v2}"
PERTH_REPO_DIR="${PERTH_REPO_DIR:-/srv/openclaw/workers/vendor/perth-ce86c49d029f}"
S3TOKENIZER_REPO_DIR="${S3TOKENIZER_REPO_DIR:-/srv/openclaw/workers/vendor/s3tokenizer-9bf5d845b5e0}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
EXPECTED_PYTHON_MINOR="3.13"
CHATTERBOX_REPOSITORY="https://github.com/resemble-ai/chatterbox.git"
CHATTERBOX_COMMIT="5de7a54aa4e5e2baadb0182dde554908b48b85c2"
PERTH_REPOSITORY="https://github.com/resemble-ai/Perth.git"
PERTH_COMMIT="ce86c49d029f42272c1902eccb675556b9ed2330"
S3TOKENIZER_REPOSITORY="https://github.com/xingchensong/S3Tokenizer.git"
S3TOKENIZER_COMMIT="9bf5d845b5e043ffaf4657f4942939091c7697a2"
TORCH_REQUIREMENTS_FILE="${DEPLOY_ROOT}/requirements/torch-chatterbox-cu124.txt"
RUNTIME_REQUIREMENTS_FILE="${DEPLOY_ROOT}/requirements/chatterbox.txt"
CONSTRAINTS_FILE="${DEPLOY_ROOT}/requirements/constraints-debian-py313-cu124.txt"
CHATTERBOX_SOURCE_PATCH_FILE="${DEPLOY_ROOT}/patches/chatterbox-source-runtime.patch"
CHATTERBOX_SOURCE_PATCH_SHA256="16ecc098c9a1d9a7fc1cdfbf223b17b90dbbc0f752dd9850de2fbd5e26c9c263"
CHATTERBOX_OFFLINE_TOKENIZER_PATCH_FILE="${DEPLOY_ROOT}/patches/chatterbox-offline-tokenizer.patch"
CHATTERBOX_OFFLINE_TOKENIZER_PATCH_SHA256="45dc46b21b7b089347892d16ccf7c2ea7f0832d53c541165c46ddff8e8af843e"
LOCK_VERIFIER="${DEPLOY_ROOT}/verify_environment_lock.py"
SERVICE_DISTRIBUTION="openclaw-local-tts==0.1.0"

umask 0027

if [[ "${EUID}" -eq 0 ]]; then
  echo "ERROR: build the Chatterbox environment as an unprivileged build user" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: the production Chatterbox profile targets Linux/Debian" >&2
  exit 2
fi
if [[ -e "${VENV_DIR}" ]]; then
  echo "ERROR: refusing to reuse an existing Chatterbox environment: ${VENV_DIR}" >&2
  exit 2
fi
if [[ -e "${CHATTERBOX_REPO_DIR}" ]]; then
  echo "ERROR: refusing to reuse an existing Chatterbox checkout: ${CHATTERBOX_REPO_DIR}" >&2
  exit 2
fi
if [[ -e "${PERTH_REPO_DIR}" ]]; then
  echo "ERROR: refusing to reuse an existing Perth checkout: ${PERTH_REPO_DIR}" >&2
  exit 2
fi
if [[ -e "${S3TOKENIZER_REPO_DIR}" ]]; then
  echo "ERROR: refusing to reuse an existing S3Tokenizer checkout: ${S3TOKENIZER_REPO_DIR}" >&2
  exit 2
fi
if [[ "${VENV_DIR}" != /* || "${CHATTERBOX_REPO_DIR}" != /* || "${PERTH_REPO_DIR}" != /* || "${S3TOKENIZER_REPO_DIR}" != /* ]]; then
  echo "ERROR: Chatterbox environment and checkout paths must be absolute" >&2
  exit 2
fi
if [[ "${VENV_DIR}" == "${SERVICE_ROOT}"/* || "${CHATTERBOX_REPO_DIR}" == "${SERVICE_ROOT}"/* || "${PERTH_REPO_DIR}" == "${SERVICE_ROOT}"/* || "${S3TOKENIZER_REPO_DIR}" == "${SERVICE_ROOT}"/* ]]; then
  echo "ERROR: Chatterbox environment and checkout must live outside the repository" >&2
  exit 2
fi

ACTUAL_PYTHON_MINOR="$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "${ACTUAL_PYTHON_MINOR}" != "${EXPECTED_PYTHON_MINOR}" ]]; then
  echo "ERROR: Chatterbox requires Python ${EXPECTED_PYTHON_MINOR}, found ${ACTUAL_PYTHON_MINOR}" >&2
  exit 2
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
VENV_PYTHON="${VENV_DIR}/bin/python"
"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --constraint "${CONSTRAINTS_FILE}" \
  --requirement "${TORCH_REQUIREMENTS_FILE}"

clone_pinned_repo() {
  local repository="$1"
  local commit="$2"
  local target="$3"
  local label="$4"

  install -d -m 0750 "$(dirname -- "${target}")"
  git clone --filter=blob:none --no-checkout "${repository}" "${target}"
  git -C "${target}" fetch --depth=1 origin "${commit}"
  git -C "${target}" checkout --detach "${commit}"
  if [[ "$(git -C "${target}" rev-parse 'HEAD^{commit}')" != "${commit}" ]]; then
    echo "ERROR: ${label} checkout verification failed" >&2
    exit 2
  fi
  if [[ -n "$(git -C "${target}" status --porcelain=v1 --untracked-files=all)" ]]; then
    echo "ERROR: ${label} checkout is dirty" >&2
    exit 2
  fi
}

clone_pinned_repo \
  "${CHATTERBOX_REPOSITORY}" "${CHATTERBOX_COMMIT}" \
  "${CHATTERBOX_REPO_DIR}" "Chatterbox"
clone_pinned_repo \
  "${PERTH_REPOSITORY}" "${PERTH_COMMIT}" \
  "${PERTH_REPO_DIR}" "Perth"
clone_pinned_repo \
  "${S3TOKENIZER_REPOSITORY}" "${S3TOKENIZER_COMMIT}" \
  "${S3TOKENIZER_REPO_DIR}" "S3Tokenizer"

if [[ "$(sha256sum "${CHATTERBOX_SOURCE_PATCH_FILE}" | awk '{print $1}')" != "${CHATTERBOX_SOURCE_PATCH_SHA256}" ]]; then
  echo "ERROR: Chatterbox source-runtime patch integrity verification failed" >&2
  exit 2
fi
git -C "${CHATTERBOX_REPO_DIR}" apply --check "${CHATTERBOX_SOURCE_PATCH_FILE}"
git -C "${CHATTERBOX_REPO_DIR}" apply "${CHATTERBOX_SOURCE_PATCH_FILE}"
if [[ "$(sha256sum "${CHATTERBOX_OFFLINE_TOKENIZER_PATCH_FILE}" | awk '{print $1}')" != "${CHATTERBOX_OFFLINE_TOKENIZER_PATCH_SHA256}" ]]; then
  echo "ERROR: Chatterbox offline-tokenizer patch integrity verification failed" >&2
  exit 2
fi
git -C "${CHATTERBOX_REPO_DIR}" apply --check "${CHATTERBOX_OFFLINE_TOKENIZER_PATCH_FILE}"
git -C "${CHATTERBOX_REPO_DIR}" apply "${CHATTERBOX_OFFLINE_TOKENIZER_PATCH_FILE}"
git -C "${CHATTERBOX_REPO_DIR}" diff --check
EXPECTED_CHATTERBOX_STATUS=$' M src/chatterbox/__init__.py\n M src/chatterbox/models/tokenizers/tokenizer.py'
if [[ "$(git -C "${CHATTERBOX_REPO_DIR}" status --porcelain=v1 --untracked-files=all)" != "${EXPECTED_CHATTERBOX_STATUS}" ]]; then
  echo "ERROR: Chatterbox source-runtime patch changed an unexpected path" >&2
  exit 2
fi

"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --constraint "${CONSTRAINTS_FILE}" \
  --requirement "${RUNTIME_REQUIREMENTS_FILE}"
"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-deps \
  "${SERVICE_ROOT}"
"${VENV_PYTHON}" -m pip check
"${VENV_PYTHON}" "${LOCK_VERIFIER}" \
  --constraints-file "${CONSTRAINTS_FILE}" \
  --expected-local-distribution "${SERVICE_DISTRIBUTION}"
PYTHONPATH="${CHATTERBOX_REPO_DIR}/src:${PERTH_REPO_DIR}/src:${S3TOKENIZER_REPO_DIR}" "${VENV_PYTHON}" -c 'import perth, s3tokenizer; from chatterbox.mtl_tts import ChatterboxMultilingualTTS, _resolve_multilingual_t3_model; assert perth.PerthImplicitWatermarker is not None; assert callable(s3tokenizer.load_model); assert callable(ChatterboxMultilingualTTS.from_local); assert _resolve_multilingual_t3_model("v3") == "t3_mtl23ls_v3.safetensors"'

echo "OpenClaw Chatterbox runtime dependencies installed in ${VENV_DIR}"
echo "Chatterbox source ${CHATTERBOX_COMMIT} verified in ${CHATTERBOX_REPO_DIR}"
echo "Chatterbox source-runtime patch ${CHATTERBOX_SOURCE_PATCH_SHA256} verified"
echo "Chatterbox offline-tokenizer patch ${CHATTERBOX_OFFLINE_TOKENIZER_PATCH_SHA256} verified"
echo "Perth source ${PERTH_COMMIT} verified in ${PERTH_REPO_DIR}"
echo "S3Tokenizer source ${S3TOKENIZER_COMMIT} verified in ${S3TOKENIZER_REPO_DIR}"
