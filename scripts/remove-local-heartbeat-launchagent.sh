#!/usr/bin/env bash

set -euo pipefail

TARGET_PLIST="${HOME}/Library/LaunchAgents/com.smolpaws.heartbeat.plist"

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
rm -f "${TARGET_PLIST}"

echo "Removed SmolPaws heartbeat LaunchAgent."
