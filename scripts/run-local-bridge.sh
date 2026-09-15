#!/usr/bin/env bash
#
# Start one standalone SmolPaws bridge against the TypeScript OpenHands agent-server.
#
#   scripts/run-local-bridge.sh <bridge> [extra npm args]
#
# <bridge> is a directory under apps/ whose plugin.json says `"kind": "standalone"`
# (slack, whatsapp, discord). The launcher:
#
#   1. loads ~/.smolpaws/.env (SMOLPAWS_ENV_FILE overrides);
#   2. exports the git SHA as SMOLPAWS_BUILD_SHA and pins the agent-server's
#      conversation persistence to ~/.smolpaws/conversations;
#   3. if no healthy agent-server answers at SMOLPAWS_RELAY_SERVER_URL
#      (default http://127.0.0.1:8790) and that URL is loopback, starts a supervised product server
#      detached (nohup, own session, logs under ~/.smolpaws/logs) and waits for
#      /health. The server is deliberately NOT stopped when the bridge exits:
#      other bridges share it, and launchd restarts bridges independently;
#   4. execs `npm --prefix apps/<bridge> run start`.
#
# This is the one entrypoint LaunchAgents use (launchd/com.smolpaws.bridge.plist),
# so "start any bridge and it just works" holds whether or not the server is up.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BRIDGE="${1:-}"
if [[ -z "$BRIDGE" || ! -d "$ROOT_DIR/apps/$BRIDGE" ]]; then
  echo "usage: $0 <bridge> (one of: $(ls "$ROOT_DIR/apps" | tr '\n' ' '))" >&2
  exit 2
fi
shift
if ! grep -q '"kind": *"standalone"' "$ROOT_DIR/apps/$BRIDGE/plugin.json" 2>/dev/null; then
  echo "apps/$BRIDGE is not a standalone relay bridge (plugin.json kind != standalone)" >&2
  exit 2
fi

SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
SMOLPAWS_ENV_FILE="${SMOLPAWS_ENV_FILE:-$SMOLPAWS_HOME_DIR/.env}"
if [[ -f "$SMOLPAWS_ENV_FILE" ]]; then
  set +u
  set -a
  # shellcheck disable=SC1090
  source "$SMOLPAWS_ENV_FILE"
  set +a
  set -u
fi
export SMOLPAWS_HOME_DIR

# Shared with heartbeat: only a product host has the SmolPaws task/media executors.
source "$ROOT_DIR/scripts/lib/product-server.sh"
SERVER_URL="${SMOLPAWS_RELAY_SERVER_URL:-${SMOLPAWS_COORD_SERVER_URL:-http://127.0.0.1:8790}}"
export SMOLPAWS_RELAY_SERVER_URL="${SERVER_URL%/}"
ensure_smolpaws_product_server "$SMOLPAWS_RELAY_SERVER_URL"

echo "[bridge:$BRIDGE] starting standalone bridge from $SMOLPAWS_BUILD_SHA…" >&2
exec npm --prefix "apps/$BRIDGE" run start -- "$@"
