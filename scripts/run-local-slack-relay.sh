#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

SERVER_URL="${SMOLPAWS_COORD_SERVER_URL:-http://127.0.0.1:8790}"
SERVER_URL="${SERVER_URL%/}"
HEALTH_URL="$SERVER_URL/health"
BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || printf 'unknown')"
export SMOLPAWS_BUILD_SHA="$BUILD_SHA"

server_pid=""
slack_pid=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP

  if [[ -n "$slack_pid" ]] && kill -0 "$slack_pid" 2>/dev/null; then
    kill "$slack_pid" 2>/dev/null || true
    wait "$slack_pid" 2>/dev/null || true
  fi

  # Stop the TypeScript server only when this launcher started it. An already-running server is left alone.
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi

  exit "$status"
}
trap cleanup EXIT INT TERM HUP

cat >&2 <<EOF
Slack Relay canary
  checkout:     $BUILD_SHA
  agent-server: $SERVER_URL

Before the first canary after upgrading, restart the normal SmolPaws host once. On the current checkout
Slack is marked standalone, so the shared bridge loader will stop opening the old Socket Mode connection.
If paws replies with "Done — nothing to report back", an older host still owns part of the Slack stream.
EOF

if ! curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
  case "$SERVER_URL" in
    http://127.0.0.1:8790|http://localhost:8790)
      echo "Starting the TypeScript OpenHands agent-server on 127.0.0.1:8790…" >&2
      npm --prefix packages/openhands-agent-server run dev:server &
      server_pid=$!
      ;;
    *)
      echo "Agent-server is not healthy at $HEALTH_URL." >&2
      echo "Start the configured non-default server separately, then rerun this command." >&2
      exit 1
      ;;
  esac

  for _ in $(seq 1 80); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      wait "$server_pid" || true
      server_pid=""
      echo "The TypeScript agent-server exited before becoming healthy." >&2
      exit 1
    fi
    sleep 0.25
  done

  if ! curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
    echo "The TypeScript agent-server did not become healthy at $HEALTH_URL." >&2
    exit 1
  fi
else
  echo "Using the already-running healthy agent-server at $SERVER_URL." >&2
fi

echo "Starting standalone paws Socket Mode bridge from $BUILD_SHA…" >&2
npm --prefix apps/slack run start &
slack_pid=$!
wait "$slack_pid"
status=$?
slack_pid=""
exit "$status"
