#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="Europe/Stockholm"
exec bash "$ROOT_DIR/scripts/run-local-smolpaws.sh" node --import tsx/esm "$ROOT_DIR/scripts/watchdog.ts" "$@"
