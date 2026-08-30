#!/usr/bin/env bash
# Verify the 6-point durable trail for a paws canary run.
# Usage: verify-paws-canary.sh [runId]   (defaults to the most recent run)
BASE="$HOME/.smolpaws/canary/slack-relay"
RUNID="${1:-}"

if [[ -z "$RUNID" ]]; then
  RUNID="$(ls -1t "$BASE" 2>/dev/null | head -1)"
fi

if [[ -z "$RUNID" ]]; then
  echo "No canary runs found under $BASE"
  exit 1
fi

DB="$BASE/$RUNID/coordinator.db"
echo "runId: $RUNID"

if [[ ! -f "$DB" ]]; then
  echo "No coordinator db at $DB"
  exit 1
fi

echo "=== work ledger (durable rows) ==="
sqlite3 -header -column "$DB" \
  "SELECT substr(id,1,10) AS id, kind, state, send_attempted AS sent,
          substr(conversation_id,1,28) AS conv,
          substr(external_message_id,1,16) AS ext_ts,
          attempts, substr(last_error,1,20) AS err
   FROM work ORDER BY sequence;"

echo
echo "=== counts by kind/state ==="
sqlite3 -header -column "$DB" "SELECT kind, state, COUNT(*) AS n FROM work GROUP BY kind, state;"

echo
echo "=== lanes ==="
sqlite3 -header -column "$DB" "SELECT substr(lane_key,1,40) AS lane, sequence FROM lanes;" 2>/dev/null
