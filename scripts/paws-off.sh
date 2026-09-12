#!/usr/bin/env bash

# Turn paws off: stop it and disable it so KeepAlive does not relaunch it and it
# stays off across reboots. The LaunchAgent remains installed; `npm run paws:on`
# brings it back.

set -euo pipefail

LABEL="com.smolpaws.paws"
DOMAIN="gui/$(id -u)"

# Disable first so KeepAlive cannot immediately respawn the process we kill.
launchctl disable "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl kill TERM "${DOMAIN}/${LABEL}" 2>/dev/null || true

echo "paws is OFF (disabled + stopped). It stays off until: npm run paws:on"
