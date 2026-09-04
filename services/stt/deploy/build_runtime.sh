#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${STT_VENV_DIR:-/srv/openclaw/workers/venvs/stt-faster-whisper-py313}"
REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements.txt"
CONSTRAINTS_FILE="${SCRIPT_DIR}/constraints-debian-py313-cu124.txt"
PYTHON_BIN="${PYTHON_BIN:-python3}"
EXPECTED_PYTHON_MINOR="3.13"

umask 0027

if [[ "${EUID}" -eq 0 ]]; then
  echo "ERROR: build the STT environment as an unprivileged build user" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: the production STT profile targets Linux/Debian" >&2
  exit 2
fi
if [[ -e "${VENV_DIR}" ]]; then
  echo "ERROR: refusing to reuse an existing STT environment: ${VENV_DIR}" >&2
  exit 2
fi
if [[ "${VENV_DIR}" != /* ]]; then
  echo "ERROR: STT environment path must be absolute" >&2
  exit 2
fi
if [[ "${VENV_DIR}" == "${SERVICE_ROOT}"/* ]]; then
  echo "ERROR: STT environment must live outside the service source" >&2
  exit 2
fi

ACTUAL_PYTHON_MINOR="$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "${ACTUAL_PYTHON_MINOR}" != "${EXPECTED_PYTHON_MINOR}" ]]; then
  echo "ERROR: STT requires Python ${EXPECTED_PYTHON_MINOR}, found ${ACTUAL_PYTHON_MINOR}" >&2
  exit 2
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
VENV_PYTHON="${VENV_DIR}/bin/python"
"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --constraint "${CONSTRAINTS_FILE}" \
  --requirement "${REQUIREMENTS_FILE}"
"${VENV_PYTHON}" -m pip install \
  --disable-pip-version-check \
  --no-cache-dir \
  --no-deps \
  "${SERVICE_ROOT}"
"${VENV_PYTHON}" -m pip check
"${VENV_PYTHON}" -c 'import ctranslate2; from faster_whisper import WhisperModel; import openclaw_local_stt'

echo "OpenClaw STT runtime installed in ${VENV_DIR}"
