#!/usr/bin/env bash

set -euo pipefail

MARKER="# smolpaws-heartbeat"
existing="$(crontab -l 2>/dev/null | grep -vF "${MARKER}" || true)"

if [[ -n "${existing}" ]]; then
  printf '%s\n' "${existing}" | crontab -
else
  crontab -r 2>/dev/null || true
fi

echo "Removed smolpaws heartbeat cron entries."
