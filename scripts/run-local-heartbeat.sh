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

export SMOLPAWS_HOME_DIR
export SMOLPAWS_WORKSPACE_ROOT="${SMOLPAWS_WORKSPACE_ROOT:-$HOME/repos}"
export SMOLPAWS_DEFAULT_WORKING_DIR="${SMOLPAWS_DEFAULT_WORKING_DIR:-smolpaws}"
mkdir -p "$SMOLPAWS_HOME_DIR/memory"

# Prefer the shared bridge endpoint; retain heartbeat's explicit legacy URL override.
export SMOLPAWS_RELAY_SERVER_URL="${SMOLPAWS_RELAY_SERVER_URL:-${SMOLPAWS_COORD_SERVER_URL:-${SMOLPAWS_RUNNER_URL:-http://${RUNNER_HOST:-127.0.0.1}:${PORT:-8790}}}}"
source "$ROOT_DIR/scripts/lib/product-server.sh"
ensure_smolpaws_product_server "$SMOLPAWS_RELAY_SERVER_URL"

exec npm --prefix apps/agent-server run heartbeat:start
