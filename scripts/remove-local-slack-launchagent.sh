#!/usr/bin/env bash

set -euo pipefail

LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
AGENT_LABEL="com.smolpaws.slack"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/${AGENT_LABEL}.plist"

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
rm -f "${TARGET_PLIST}"

echo "Removed SmolPaws Slack Relay LaunchAgent."
