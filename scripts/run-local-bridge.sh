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

LOG_DIR="$SMOLPAWS_HOME_DIR/logs"
mkdir -p "$LOG_DIR"

SERVER_URL="${SMOLPAWS_RELAY_SERVER_URL:-${SMOLPAWS_COORD_SERVER_URL:-http://127.0.0.1:8790}}"
SERVER_URL="${SERVER_URL%/}"
export SMOLPAWS_RELAY_SERVER_URL="$SERVER_URL"
HEALTH_URL="$SERVER_URL/health"
export SMOLPAWS_BUILD_SHA="${SMOLPAWS_BUILD_SHA:-$(git rev-parse HEAD 2>/dev/null || printf 'unknown')}"

# Stable absolute persistence so a server restart from another cwd never strands conversations.
export PERSISTENCE_DIR="${PERSISTENCE_DIR:-$SMOLPAWS_HOME_DIR/conversations}"
mkdir -p "$PERSISTENCE_DIR"

is_loopback_url() {
  case "$1" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) return 0 ;;
    *) return 1 ;;
  esac
}

server_healthy() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

ensure_agent_server() {
  if server_healthy; then
    if ! curl -fsSI --max-time 2 "$HEALTH_URL" | grep -qi '^x-smolpaws-host: relay'; then
      echo "[bridge:$BRIDGE] healthy endpoint is not the SmolPaws product server; use npm run relay-server:start for scheduler/media support." >&2
      return 1
    fi
    echo "[bridge:$BRIDGE] using healthy agent-server at $SERVER_URL" >&2
    return 0
  fi
  if ! is_loopback_url "$SERVER_URL"; then
    echo "[bridge:$BRIDGE] agent-server is not healthy at $HEALTH_URL and is not loopback; start it separately." >&2
    return 1
  fi

  local port="${SERVER_URL##*:}"
  export OPENHANDS_AGENT_SERVER_PORT="$port"
  export OPENHANDS_AGENT_SERVER_HOST="${OPENHANDS_AGENT_SERVER_HOST:-127.0.0.1}"
  echo "[bridge:$BRIDGE] starting the TypeScript OpenHands agent-server on $SERVER_URL…" >&2
  # Detached: its own session, no controlling terminal, survives this launcher and the bridge.
  nohup node --import tsx/esm apps/relay-server/src/supervise.ts \
    >>"$LOG_DIR/openhands-agent-server-$port.log" 2>&1 </dev/null &
  disown || true

  local i
  for i in $(seq 1 120); do
    if server_healthy; then
      echo "[bridge:$BRIDGE] agent-server is healthy." >&2
      return 0
    fi
    sleep 0.5
  done
  echo "[bridge:$BRIDGE] agent-server did not become healthy at $HEALTH_URL (see $LOG_DIR/openhands-agent-server-$port.log)" >&2
  return 1
}

ensure_agent_server

echo "[bridge:$BRIDGE] starting standalone bridge from $SMOLPAWS_BUILD_SHA…" >&2
exec npm --prefix "apps/$BRIDGE" run start -- "$@"
