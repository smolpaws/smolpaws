#!/usr/bin/env bash

# Remove the paws LaunchAgent entirely (stop, unload, delete the plist).

set -euo pipefail

LABEL="com.smolpaws.paws"
DOMAIN="gui/$(id -u)"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "${DOMAIN}" "${TARGET_PLIST}" >/dev/null 2>&1 || true
launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
rm -f "${TARGET_PLIST}"

echo "Removed paws LaunchAgent: ${TARGET_PLIST}"
