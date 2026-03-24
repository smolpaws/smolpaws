#!/usr/bin/env bash

set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
SMOLPAWS_ENV_FILE="${SMOLPAWS_ENV_FILE:-$SMOLPAWS_HOME_DIR/.env}"
if [[ -f "${SMOLPAWS_ENV_FILE}" ]]; then
  set +u
  set -a
  # shellcheck disable=SC1090
  source "${SMOLPAWS_ENV_FILE}"
  set +a
  set -u
fi

export PORT="${PORT:-8788}"
export RUNNER_HOST="${RUNNER_HOST:-127.0.0.1}"
export SMOLPAWS_WORKSPACE_ROOT="${SMOLPAWS_WORKSPACE_ROOT:-$HOME/repos}"
export SMOLPAWS_DEFAULT_WORKING_DIR="${SMOLPAWS_DEFAULT_WORKING_DIR:-smolpaws}"
LOG_DIR="${SMOLPAWS_HOME_DIR}/logs"

resolve_runner_base_url() {
  if [[ -n "${SMOLPAWS_RUNNER_URL:-}" ]]; then
    printf '%s\n' "${SMOLPAWS_RUNNER_URL%/}"
    return
  fi
  printf 'http://%s:%s\n' "${RUNNER_HOST}" "${PORT}"
}

is_local_runner_base_url() {
  case "$1" in
    http://127.0.0.1:*|http://localhost:*|http://[::1]:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

runner_ready() {
  curl --silent --show-error --fail "$1/ready" >/dev/null
}

start_local_runner_if_needed() {
  local base_url="$1"
  if runner_ready "${base_url}"; then
    return 0
  fi

  if ! is_local_runner_base_url "${base_url}" || [[ -n "${SMOLPAWS_RUNNER_URL:-}" ]]; then
    echo "[heartbeat] runner unavailable at ${base_url}" >&2
    return 1
  fi

  mkdir -p "${LOG_DIR}"
  python3 - "${ROOT_DIR}" "${LOG_DIR}" <<'PY'
from pathlib import Path
import subprocess
import sys

root_dir, log_dir = sys.argv[1:]
stdout_path = Path(log_dir) / 'agent-server.launchagent.log'
stderr_path = Path(log_dir) / 'agent-server.launchagent.error.log'
with stdout_path.open('a') as stdout, stderr_path.open('a') as stderr:
    subprocess.Popen(
        [str(Path(root_dir) / 'scripts' / 'run-local-agent-server.sh')],
        cwd=root_dir,
        stdin=subprocess.DEVNULL,
        stdout=stdout,
        stderr=stderr,
        start_new_session=True,
        close_fds=True,
    )
PY

  for _ in $(seq 1 30); do
    if runner_ready "${base_url}"; then
      return 0
    fi
    sleep 1
  done

  echo "[heartbeat] local runner did not become ready at ${base_url}" >&2
  return 1
}

RUNNER_BASE_URL="$(resolve_runner_base_url)"
start_local_runner_if_needed "${RUNNER_BASE_URL}"

exec npm --prefix apps/agent-server run heartbeat:start
