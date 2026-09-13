#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_BASE="${TMPDIR:-/tmp}"
TEMP_BASE="${TEMP_BASE%/}"
TEST_ROOT="$(mktemp -d "${TEMP_BASE}/smolpaws-slack-service.XXXXXX")"

cleanup_test_root() {
  local status=$?
  trap - EXIT
  case "$TEST_ROOT" in
    "${TEMP_BASE}"/smolpaws-slack-service.*)
      rm -rf -- "$TEST_ROOT"
      ;;
  esac
  exit "$status"
}
trap cleanup_test_root EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_line() {
  local expected="$1"
  local file="$2"
  if ! grep -Fqx -- "$expected" "$file"; then
    echo "Expected line: $expected" >&2
    echo "Actual ${file}:" >&2
    sed -n '1,120p' "$file" >&2
    fail "expected line was not found"
  fi
}

for script in \
  scripts/run-local-slack-relay.sh \
  scripts/install-local-slack-launchagent.sh \
  scripts/remove-local-slack-launchagent.sh; do
  bash -n "${ROOT_DIR}/${script}"
done

FAKE_BIN="${TEST_ROOT}/bin"
mkdir -p "$FAKE_BIN"

cat >"${FAKE_BIN}/launchctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_LAUNCHCTL_LOG"
SH

cat >"${FAKE_BIN}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
last_argument=""
for argument in "$@"; do
  last_argument="$argument"
done
printf '%s\n' "$last_argument" >>"$FAKE_CURL_LOG"
case "${FAKE_CURL_MODE:-healthy}" in
  healthy)
    exit 0
    ;;
  marker)
    [[ -f "$FAKE_HEALTH_MARKER" ]]
    ;;
  *)
    echo "Unknown FAKE_CURL_MODE: $FAKE_CURL_MODE" >&2
    exit 2
    ;;
esac
SH

cat >"${FAKE_BIN}/node" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "$PWD" in
  */packages/openhands-agent-server)
    component="server"
    ;;
  */apps/slack)
    component="slack"
    ;;
  *)
    echo "Unexpected fake node cwd: $PWD" >&2
    exit 2
    ;;
esac

printf '%s|%s|%s|%s|%s\n' \
  "$component" \
  "$*" \
  "${SMOLPAWS_RELAY_SERVER_URL:-}" \
  "${SMOLPAWS_RELAY_SERVER_API_KEY:-}" \
  "${OPENHANDS_SESSION_API_KEY:-}" \
  >>"$FAKE_NODE_LOG"

run_until_stopped() {
  trap 'printf "%s-stopped\n" "$component" >>"$FAKE_STOP_LOG"; exit 0' TERM INT HUP
  while true; do
    sleep 0.1
  done
}

if [[ "$component" == "server" ]]; then
  touch "$FAKE_HEALTH_MARKER"
  case "${FAKE_SERVER_MODE:-loop}" in
    exit)
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        [[ -f "$FAKE_SLACK_READY_MARKER" ]] && break
        sleep 0.1
      done
      [[ -f "$FAKE_SLACK_READY_MARKER" ]] || exit 2
      exit "${FAKE_SERVER_EXIT_CODE:-42}"
      ;;
    loop)
      run_until_stopped
      ;;
    *)
      echo "Unknown FAKE_SERVER_MODE: $FAKE_SERVER_MODE" >&2
      exit 2
      ;;
  esac
else
  touch "$FAKE_SLACK_READY_MARKER"
  case "${FAKE_SLACK_MODE:-loop}" in
    exit)
      sleep 0.2
      exit "${FAKE_SLACK_EXIT_CODE:-23}"
      ;;
    loop)
      run_until_stopped
      ;;
    *)
      echo "Unknown FAKE_SLACK_MODE: $FAKE_SLACK_MODE" >&2
      exit 2
      ;;
  esac
fi
SH

chmod +x "${FAKE_BIN}/launchctl" "${FAKE_BIN}/curl" "${FAKE_BIN}/node"

ORIGINAL_PATH="$PATH"
FAKE_PATH="${FAKE_BIN}:${ORIGINAL_PATH}"
FAKE_LAUNCHCTL_LOG="${TEST_ROOT}/launchctl.log"
FAKE_CURL_LOG="${TEST_ROOT}/curl.log"
FAKE_NODE_LOG="${TEST_ROOT}/node.log"
FAKE_STOP_LOG="${TEST_ROOT}/stop.log"
FAKE_HEALTH_MARKER="${TEST_ROOT}/healthy"
FAKE_SLACK_READY_MARKER="${TEST_ROOT}/slack-ready"
export FAKE_LAUNCHCTL_LOG FAKE_CURL_LOG FAKE_NODE_LOG FAKE_STOP_LOG FAKE_HEALTH_MARKER FAKE_SLACK_READY_MARKER
touch "$FAKE_LAUNCHCTL_LOG" "$FAKE_CURL_LOG" "$FAKE_NODE_LOG" "$FAKE_STOP_LOG"

# The installer renders a valid plist into the user's LaunchAgents directory and invokes launchctl.
TEST_HOME="${TEST_ROOT}/home & den"
TEST_STATE="${TEST_ROOT}/state & paws"
mkdir -p "$TEST_HOME"
HOME="$TEST_HOME" SMOLPAWS_HOME_DIR="$TEST_STATE" PATH="$FAKE_PATH" \
  "${ROOT_DIR}/scripts/install-local-slack-launchagent.sh" >/dev/null

TARGET_PLIST="${TEST_HOME}/Library/LaunchAgents/com.smolpaws.slack.plist"
[[ -f "$TARGET_PLIST" ]] || fail "installer did not create ${TARGET_PLIST}"

python3 - "$TARGET_PLIST" "$ROOT_DIR" "$TEST_HOME" "$TEST_STATE" <<'PY'
import plistlib
import sys

plist_path, project_root, home, state = sys.argv[1:]
with open(plist_path, 'rb') as stream:
    value = plistlib.load(stream)

assert value['Label'] == 'com.smolpaws.slack'
assert value['ProgramArguments'] == [f'{project_root}/scripts/run-local-slack-relay.sh']
assert value['WorkingDirectory'] == project_root
assert value['RunAtLoad'] is True
assert value['KeepAlive'] is True
assert value['ThrottleInterval'] == 10
assert value['EnvironmentVariables']['HOME'] == home
assert value['EnvironmentVariables']['SMOLPAWS_HOME_DIR'] == state
assert value['StandardOutPath'] == f'{state}/logs/slack-relay.launchagent.log'
assert value['StandardErrorPath'] == f'{state}/logs/slack-relay.launchagent.error.log'
PY

USER_ID="$(id -u)"
assert_line "bootstrap gui/${USER_ID} ${TARGET_PLIST}" "$FAKE_LAUNCHCTL_LOG"
assert_line "enable gui/${USER_ID}/com.smolpaws.slack" "$FAKE_LAUNCHCTL_LOG"
assert_line "kickstart -k gui/${USER_ID}/com.smolpaws.slack" "$FAKE_LAUNCHCTL_LOG"

HOME="$TEST_HOME" PATH="$FAKE_PATH" \
  "${ROOT_DIR}/scripts/remove-local-slack-launchagent.sh" >/dev/null
[[ ! -e "$TARGET_PLIST" ]] || fail "remove script left ${TARGET_PLIST} behind"

# The preferred RELAY URL must drive both the health check and the Slack process even when a legacy
# COORD URL is also present. A healthy external server must never be started or stopped by this launcher.
: >"$FAKE_CURL_LOG"
: >"$FAKE_NODE_LOG"
set +e
HOME="$TEST_HOME" SMOLPAWS_HOME_DIR="$TEST_STATE" SMOLPAWS_ENV_FILE="${TEST_ROOT}/missing.env" \
  SMOLPAWS_RELAY_SERVER_URL="http://relay.example.test" \
  SMOLPAWS_COORD_SERVER_URL="http://legacy.example.test" \
  SMOLPAWS_RELAY_SERVER_API_KEY="external-relay-key" \
  SMOLPAWS_COORD_SERVER_API_KEY="external-legacy-key" \
  OPENHANDS_SESSION_API_KEY= SESSION_API_KEY= \
  FAKE_CURL_MODE=healthy FAKE_SLACK_MODE=exit FAKE_SLACK_EXIT_CODE=0 \
  PATH="$FAKE_PATH" "${ROOT_DIR}/scripts/run-local-slack-relay.sh" \
  >"${TEST_ROOT}/preferred-url.out" 2>&1
status=$?
set -e
[[ "$status" -eq 0 ]] || {
  sed -n '1,160p' "${TEST_ROOT}/preferred-url.out" >&2
  fail "expected healthy external-server run to exit 0, got ${status}"
}
assert_line "http://relay.example.test/health" "$FAKE_CURL_LOG"
assert_line "slack|--import tsx/esm src/index.ts|http://relay.example.test|external-relay-key|" "$FAKE_NODE_LOG"
if grep -q '^server|' "$FAKE_NODE_LOG"; then
  fail "launcher started a server even though the configured server was healthy"
fi

# If the locally-managed server exits, the launcher must terminate Slack and propagate a non-zero status
# so KeepAlive restarts the complete unit.
: >"$FAKE_CURL_LOG"
: >"$FAKE_NODE_LOG"
: >"$FAKE_STOP_LOG"
rm -f "$FAKE_HEALTH_MARKER"
rm -f "$FAKE_SLACK_READY_MARKER"
set +e
HOME="$TEST_HOME" SMOLPAWS_HOME_DIR="$TEST_STATE" SMOLPAWS_ENV_FILE="${TEST_ROOT}/missing.env" \
  SMOLPAWS_RELAY_SERVER_URL= SMOLPAWS_COORD_SERVER_URL= \
  SMOLPAWS_RELAY_SERVER_API_KEY="preferred-client-key" \
  SMOLPAWS_COORD_SERVER_API_KEY="legacy-client-key" \
  OPENHANDS_SESSION_API_KEY= SESSION_API_KEY= \
  FAKE_CURL_MODE=marker FAKE_SERVER_MODE=exit FAKE_SERVER_EXIT_CODE=0 FAKE_SLACK_MODE=loop \
  PATH="$FAKE_PATH" "${ROOT_DIR}/scripts/run-local-slack-relay.sh" \
  >"${TEST_ROOT}/server-exit.out" 2>&1
status=$?
set -e
[[ "$status" -eq 1 ]] || {
  sed -n '1,160p' "${TEST_ROOT}/server-exit.out" >&2
  fail "expected an unexpected clean server exit to become status 1, got ${status}"
}
assert_line "server|--import tsx/esm src/cli.ts|http://127.0.0.1:8790|preferred-client-key|preferred-client-key" "$FAKE_NODE_LOG"
assert_line "slack|--import tsx/esm src/index.ts|http://127.0.0.1:8790|preferred-client-key|preferred-client-key" "$FAKE_NODE_LOG"
assert_line "slack-stopped" "$FAKE_STOP_LOG"

# A legacy client key must also configure both sides of a locally-owned unit. If Slack exits, the
# launcher must stop the locally-owned server and return Slack's status.
: >"$FAKE_CURL_LOG"
: >"$FAKE_NODE_LOG"
: >"$FAKE_STOP_LOG"
rm -f "$FAKE_HEALTH_MARKER"
rm -f "$FAKE_SLACK_READY_MARKER"
set +e
HOME="$TEST_HOME" SMOLPAWS_HOME_DIR="$TEST_STATE" SMOLPAWS_ENV_FILE="${TEST_ROOT}/missing.env" \
  SMOLPAWS_RELAY_SERVER_URL= SMOLPAWS_COORD_SERVER_URL= \
  SMOLPAWS_RELAY_SERVER_API_KEY= SMOLPAWS_COORD_SERVER_API_KEY="legacy-client-key" \
  OPENHANDS_SESSION_API_KEY= SESSION_API_KEY= \
  FAKE_CURL_MODE=marker FAKE_SERVER_MODE=loop FAKE_SLACK_MODE=exit FAKE_SLACK_EXIT_CODE=23 \
  PATH="$FAKE_PATH" "${ROOT_DIR}/scripts/run-local-slack-relay.sh" \
  >"${TEST_ROOT}/slack-exit.out" 2>&1
status=$?
set -e
[[ "$status" -eq 23 ]] || {
  sed -n '1,160p' "${TEST_ROOT}/slack-exit.out" >&2
  fail "expected Slack exit status 23, got ${status}"
}
assert_line "server|--import tsx/esm src/cli.ts|http://127.0.0.1:8790|legacy-client-key|legacy-client-key" "$FAKE_NODE_LOG"
assert_line "slack|--import tsx/esm src/index.ts|http://127.0.0.1:8790|legacy-client-key|legacy-client-key" "$FAKE_NODE_LOG"
assert_line "server-stopped" "$FAKE_STOP_LOG"

# An explicitly configured server key wins over client aliases, and Slack must use that same value.
: >"$FAKE_CURL_LOG"
: >"$FAKE_NODE_LOG"
: >"$FAKE_STOP_LOG"
rm -f "$FAKE_HEALTH_MARKER"
rm -f "$FAKE_SLACK_READY_MARKER"
set +e
HOME="$TEST_HOME" SMOLPAWS_HOME_DIR="$TEST_STATE" SMOLPAWS_ENV_FILE="${TEST_ROOT}/missing.env" \
  SMOLPAWS_RELAY_SERVER_URL= SMOLPAWS_COORD_SERVER_URL= \
  SMOLPAWS_RELAY_SERVER_API_KEY="different-client-key" \
  SMOLPAWS_COORD_SERVER_API_KEY="legacy-client-key" \
  OPENHANDS_SESSION_API_KEY="explicit-server-key" SESSION_API_KEY="secondary-server-key" \
  FAKE_CURL_MODE=marker FAKE_SERVER_MODE=loop FAKE_SLACK_MODE=exit FAKE_SLACK_EXIT_CODE=24 \
  PATH="$FAKE_PATH" "${ROOT_DIR}/scripts/run-local-slack-relay.sh" \
  >"${TEST_ROOT}/explicit-server-key.out" 2>&1
status=$?
set -e
[[ "$status" -eq 24 ]] || {
  sed -n '1,160p' "${TEST_ROOT}/explicit-server-key.out" >&2
  fail "expected Slack exit status 24, got ${status}"
}
assert_line "server|--import tsx/esm src/cli.ts|http://127.0.0.1:8790|explicit-server-key|explicit-server-key" "$FAKE_NODE_LOG"
assert_line "slack|--import tsx/esm src/index.ts|http://127.0.0.1:8790|explicit-server-key|explicit-server-key" "$FAKE_NODE_LOG"
assert_line "server-stopped" "$FAKE_STOP_LOG"

echo "Slack service tooling tests passed"
