#!/usr/bin/env bash
set -euo pipefail
LABEL="com.smolpaws.log-maintenance"
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
rm -f "${HOME}/Library/LaunchAgents/${LABEL}.plist"
echo "Removed ${LABEL}; service logs, tail checkpoints and helper are preserved."
