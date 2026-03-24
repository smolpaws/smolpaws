#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
SMOLPAWS_HEARTBEAT_CRON="${SMOLPAWS_HEARTBEAT_CRON:-0 * * * *}"
LOG_DIR="${SMOLPAWS_HOME_DIR}/logs"
MARKER="# smolpaws-heartbeat"
COMMAND="${ROOT_DIR}/scripts/run-local-heartbeat.sh >> ${LOG_DIR}/heartbeat.log 2>&1 ${MARKER}"

mkdir -p "${LOG_DIR}"

existing="$(crontab -l 2>/dev/null | grep -vF "${MARKER}" || true)"
{
  if [[ -n "${existing}" ]]; then
    printf '%s\n' "${existing}"
  fi
  printf '%s %s\n' "${SMOLPAWS_HEARTBEAT_CRON}" "${COMMAND}"
} | crontab -

echo "Installed smolpaws heartbeat cron:"
echo "${SMOLPAWS_HEARTBEAT_CRON} ${COMMAND}"
