#!/usr/bin/env bash

# Turn paws on: enable the LaunchAgent and start it now. With KeepAlive, launchd
# keeps it running (restarting on crash) until `npm run paws:off`.

set -euo pipefail

LABEL="com.smolpaws.paws"
DOMAIN="gui/$(id -u)"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "${TARGET_PLIST}" ]]; then
  echo "paws LaunchAgent is not installed. Run: npm run paws:launchagent:install" >&2
  exit 1
fi

# Ensure it is bootstrapped (loaded) before enabling.
launchctl bootstrap "${DOMAIN}" "${TARGET_PLIST}" >/dev/null 2>&1 || true
launchctl enable "${DOMAIN}/${LABEL}"
launchctl kickstart -k "${DOMAIN}/${LABEL}"

echo "paws is ON (enabled + started). It will self-restart on crash."
echo "Logs: ${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}/logs/paws.launchagent.log"
