#!/usr/bin/env bash
# Launch the Slack Relay live canary for the `paws` bot in Liberty Labs.
# Tokens are read from macOS Keychain (service `openhands`), never printed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SLACK_BOT_TOKEN="$(security find-generic-password -s openhands -a SLACK_BOT_TOKEN -w 2>/dev/null)"
SLACK_APP_TOKEN="$(security find-generic-password -s openhands -a SLACK_APP_TOKEN -w 2>/dev/null)"
export SLACK_BOT_TOKEN SLACK_APP_TOKEN

# Restrict to the Liberty Labs workspace only.
export SLACK_ALLOWED_TEAM_IDS="${SLACK_ALLOWED_TEAM_IDS:-T098D7CB7JP}"

exec npm --prefix apps/slack run live:relay-canary
