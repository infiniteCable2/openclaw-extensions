#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${TTS_VENV_DIR:-/srv/openclaw/workers/venvs/tts-chatterbox-py313}"
WHEELHOUSE_DIR="${TTS_WHEELHOUSE_DIR:-/srv/openclaw/workers/wheelhouses/tts/chatterbox-py313-cu124-1c3deb5c02b6}"
SERVICE_WHEEL="${TTS_SERVICE_WHEEL:-}"
SERVICE_WHEEL_SHA256="${TTS_SERVICE_WHEEL_SHA256:-}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
VERIFIER_PYTHON_BIN="${TTS_VERIFIER_PYTHON_BIN:-${PYTHON_BIN}}"
EXPECTED_PYTHON_MINOR="3.13"
TORCH_REQUIREMENTS_FILE="${DEPLOY_ROOT}/requirements/torch-chatterbox-cu124.txt"
RUNTIME_REQUIREMENTS_FILE="${DEPLOY_ROOT}/requirements/chatterbox.txt"
CONSTRAINTS_FILE="${DEPLOY_ROOT}/requirements/constraints-debian-py313-cu124.txt"
LOCK_VERIFIER="${DEPLOY_ROOT}/verify_environment_lock.py"
WHEELHOUSE_VERIFIER="${DEPLOY_ROOT}/wheelhouse_artifact.py"
SERVICE_DISTRIBUTION="openclaw-local-tts==0.1.0"

umask 0027
export PIP_CONFIG_FILE=/dev/null
export PIP_DISABLE_PIP_VERSION_CHECK=1
export PIP_NO_CACHE_DIR=1
export PIP_NO_INDEX=1

if [[ "${EUID}" -eq 0 ]]; then
  echo "ERROR: build the Chatterbox runtime as an unprivileged build user" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: the production Chatterbox profile targets Linux/Debian" >&2
  exit 2
fi
if [[ "${VENV_DIR}" != /* || "${WHEELHOUSE_DIR}" != /* || "${SERVICE_WHEEL}" != /* ]]; then
  echo "ERROR: Chatterbox runtime, wheelhouse, and service wheel paths must be absolute" >&2
  exit 2
fi
if [[ "${PYTHON_BIN}" != */* ]]; then
  PYTHON_BIN="$(command -v -- "${PYTHON_BIN}" || true)"
fi
if [[ -z "${PYTHON_BIN}" || ! -x "${PYTHON_BIN}" ]]; then
  echo "ERROR: Chatterbox build Python is not executable" >&2
  exit 2
fi
if [[ "${VERIFIER_PYTHON_BIN}" != */* ]]; then
  VERIFIER_PYTHON_BIN="$(command -v -- "${VERIFIER_PYTHON_BIN}" || true)"
fi
if [[ -z "${VERIFIER_PYTHON_BIN}" || ! -x "${VERIFIER_PYTHON_BIN}" ]]; then
  echo "ERROR: wheelhouse verifier Python is not executable" >&2
  exit 2
fi
if [[ -L "${VENV_DIR}" || ( -e "${VENV_DIR}" && ! -d "${VENV_DIR}" ) ]]; then
  echo "ERROR: Chatterbox environment target is not a safe directory: ${VENV_DIR}" >&2
  exit 2
fi
if [[ -d "${VENV_DIR}" ]] && find "${VENV_DIR}" -mindepth 1 -print -quit | grep -q .; then
  echo "ERROR: refusing to reuse a non-empty Chatterbox environment: ${VENV_DIR}" >&2
  exit 2
fi
if [[ -L "${WHEELHOUSE_DIR}" || ! -d "${WHEELHOUSE_DIR}" ]]; then
  echo "ERROR: Chatterbox wheelhouse is missing or unsafe: ${WHEELHOUSE_DIR}" >&2
  exit 2
fi
if [[ -L "${SERVICE_WHEEL}" || ! -f "${SERVICE_WHEEL}" ]]; then
  echo "ERROR: OpenClaw TTS service wheel is missing or unsafe" >&2
  exit 2
fi
if [[ ! "${SERVICE_WHEEL_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: OpenClaw TTS service wheel digest is invalid" >&2
  exit 2
fi
if [[ "$(sha256sum -- "${SERVICE_WHEEL}" | awk '{print $1}')" != "${SERVICE_WHEEL_SHA256}" ]]; then
  echo "ERROR: OpenClaw TTS service wheel digest mismatch" >&2
  exit 2
fi

ACTUAL_PYTHON_MINOR="$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "${ACTUAL_PYTHON_MINOR}" != "${EXPECTED_PYTHON_MINOR}" ]]; then
  echo "ERROR: Chatterbox requires Python ${EXPECTED_PYTHON_MINOR}, found ${ACTUAL_PYTHON_MINOR}" >&2
  exit 2
fi
"${VERIFIER_PYTHON_BIN}" "${WHEELHOUSE_VERIFIER}" \
  --wheelhouse "${WHEELHOUSE_DIR}" \
  --lock-file "${CONSTRAINTS_FILE}" \
  --verify-only

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
VENV_PYTHON="${VENV_DIR}/bin/python"

"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-index \
  --only-binary=:all: \
  --find-links "${WHEELHOUSE_DIR}" \
  --constraint "${CONSTRAINTS_FILE}" \
  --requirement "${TORCH_REQUIREMENTS_FILE}"

"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-index \
  --only-binary=:all: \
  --find-links "${WHEELHOUSE_DIR}" \
  --constraint "${CONSTRAINTS_FILE}" \
  --requirement "${RUNTIME_REQUIREMENTS_FILE}"

"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-index \
  --only-binary=:all: \
  --no-deps \
  "${SERVICE_WHEEL}"

"${VENV_PYTHON}" -m pip check
"${VENV_PYTHON}" "${LOCK_VERIFIER}" \
  --constraints-file "${CONSTRAINTS_FILE}" \
  --expected-local-distribution "${SERVICE_DISTRIBUTION}"

echo "OpenClaw Chatterbox runtime installed offline in ${VENV_DIR}"
