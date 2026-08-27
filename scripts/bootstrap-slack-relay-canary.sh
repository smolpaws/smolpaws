#!/usr/bin/env bash

# Prepare and launch an isolated, self-expiring Liberty Labs Slack Relay canary.
#
# Safety properties:
# - clones/fetches into ~/.smolpaws/canary/slack-relay-checkout;
# - never modifies the normal ~/repos/smolpaws checkout;
# - never stops or reconfigures the ordinary paws process;
# - uses a separate agent-server port, state tree, and coordinator database;
# - inherits Slack credentials from ~/.smolpaws/.env without printing them;
# - the live process stops itself after SMOLPAWS_CANARY_MAX_MS (10 minutes by default).

set -euo pipefail

REPOSITORY_URL="${SMOLPAWS_CANARY_REPOSITORY_URL:-https://github.com/enyst/smolpaws.git}"
REF="${SMOLPAWS_CANARY_REF:-main}"
CANARY_HOME="${SMOLPAWS_CANARY_HOME:-$HOME/.smolpaws/canary}"
CHECKOUT="${SMOLPAWS_CANARY_CHECKOUT:-$CANARY_HOME/slack-relay-checkout}"
BOOTSTRAP_LOG="$CANARY_HOME/bootstrap.log"
CURRENT_PID="$CANARY_HOME/current.pid"
CURRENT_RUN="$CANARY_HOME/current-run.txt"
PORT="${SMOLPAWS_CANARY_PORT:-8791}"
MAX_MS="${SMOLPAWS_CANARY_MAX_MS:-600000}"

mkdir -p "$CANARY_HOME"
exec >>"$BOOTSTRAP_LOG" 2>&1

echo "[$(date -u +%FT%TZ)] Slack Relay canary bootstrap starting"

if [[ -f "$CURRENT_PID" ]]; then
  previous_pid="$(cat "$CURRENT_PID" 2>/dev/null || true)"
  if [[ -n "$previous_pid" ]] && kill -0 "$previous_pid" 2>/dev/null; then
    echo "A Slack Relay canary is already running as PID $previous_pid"
    exit 0
  fi
fi

if [[ -d "$CHECKOUT/.git" ]]; then
  git -C "$CHECKOUT" remote set-url origin "$REPOSITORY_URL"
else
  rm -rf "$CHECKOUT"
  git clone --no-checkout "$REPOSITORY_URL" "$CHECKOUT"
fi

git -C "$CHECKOUT" fetch --depth=1 origin "$REF"
git -C "$CHECKOUT" checkout --detach --force FETCH_HEAD
SHA="$(git -C "$CHECKOUT" rev-parse HEAD)"
SHORT_SHA="${SHA:0:12}"
RUN_ID="${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
RUN_ROOT="$CANARY_HOME/runs/$RUN_ID"
LIVE_LOG="$RUN_ROOT/live.log"
RESPONSE="${SMOLPAWS_CANARY_RESPONSE:-RELAY-LIVE-$SHORT_SHA}"

mkdir -p "$RUN_ROOT"
printf '%s\n' "$RUN_ID" >"$CURRENT_RUN"

echo "[$(date -u +%FT%TZ)] Installing isolated canary checkout $SHA"
(
  cd "$CHECKOUT"
  npm ci
  npm ci --prefix packages/openhands-agent-server
  npm ci --prefix apps/slack
)

echo "[$(date -u +%FT%TZ)] Starting canary response=$RESPONSE port=$PORT run=$RUN_ID"
nohup "$CHECKOUT/scripts/run-local-smolpaws.sh" \
  env \
    SMOLPAWS_CANARY_RUN_ID="$RUN_ID" \
    SMOLPAWS_CANARY_ROOT="$RUN_ROOT" \
    SMOLPAWS_CANARY_COMMIT="$SHA" \
    SMOLPAWS_CANARY_RESPONSE="$RESPONSE" \
    SMOLPAWS_CANARY_PORT="$PORT" \
    SMOLPAWS_CANARY_MAX_MS="$MAX_MS" \
    npm --prefix apps/slack run live:relay-canary \
  >"$LIVE_LOG" 2>&1 &
PID=$!
printf '%s\n' "$PID" >"$CURRENT_PID"

for _ in $(seq 1 120); do
  if [[ -f "$RUN_ROOT/ready.json" ]]; then
    cp "$RUN_ROOT/ready.json" "$CANARY_HOME/current.json"
    echo "[$(date -u +%FT%TZ)] Slack Relay canary ready pid=$PID response=$RESPONSE"
    exit 0
  fi
  if [[ -f "$RUN_ROOT/failed.json" ]] || ! kill -0 "$PID" 2>/dev/null; then
    echo "[$(date -u +%FT%TZ)] Slack Relay canary failed"
    tail -n 100 "$LIVE_LOG" || true
    exit 1
  fi
  sleep 1
done

echo "[$(date -u +%FT%TZ)] Timed out waiting for Slack Relay canary readiness"
tail -n 100 "$LIVE_LOG" || true
exit 1
