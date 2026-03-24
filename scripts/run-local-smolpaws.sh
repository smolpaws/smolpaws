#!/usr/bin/env bash

set -euo pipefail

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

if [[ "$#" -eq 0 ]]; then
  exec npm run dev:start
fi

exec "$@"
