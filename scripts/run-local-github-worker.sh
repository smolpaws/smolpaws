#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
SMOLPAWS_ENV_FILE="${SMOLPAWS_ENV_FILE:-$SMOLPAWS_HOME_DIR/.env}"
GITHUB_APP_DIR="$ROOT_DIR/apps/github"
DEV_ENV_NAME="smolpaws"
DEV_VARS_FILE="$GITHUB_APP_DIR/.dev.vars.${DEV_ENV_NAME}"

if [[ -f "${SMOLPAWS_ENV_FILE}" ]]; then
  set +u
  set -a
  # shellcheck disable=SC1090
  source "${SMOLPAWS_ENV_FILE}"
  set +a
  set -u
fi

export SMOLPAWS_RUNNER_URL="${SMOLPAWS_RUNNER_URL:-http://127.0.0.1:8788}"

mkdir -p "$GITHUB_APP_DIR"

cleanup() {
  rm -f "$DEV_VARS_FILE"
}
trap cleanup EXIT

{
  for key in \
    GITHUB_WEBHOOK_SECRET \
    GITHUB_APP_ID \
    GITHUB_APP_PRIVATE_KEY \
    GITHUB_USER_TOKEN \
    ALLOWED_ACTORS \
    ALLOWED_OWNERS \
    ALLOWED_REPOS \
    ALLOWED_INSTALLATIONS \
    SMOLPAWS_RUNNER_URL \
    SMOLPAWS_RUNNER_TOKEN
  do
    value="${!key-}"
    if [[ -n "${value}" ]]; then
      printf '%s=%q\n' "$key" "$value"
    fi
  done
} > "$DEV_VARS_FILE"

echo "Starting local GitHub ingress on http://127.0.0.1:8787"
echo "Runner URL: ${SMOLPAWS_RUNNER_URL}"
if [[ -f "${SMOLPAWS_ENV_FILE}" ]]; then
  echo "Loaded env file: ${SMOLPAWS_ENV_FILE}"
fi
if [[ -n "${GITHUB_WEBHOOK_SECRET:-}" ]]; then
  echo "GitHub webhook secret: configured"
else
  echo "GitHub webhook secret: missing"
fi
if [[ -n "${GITHUB_APP_ID:-}" ]] && [[ -n "${GITHUB_APP_PRIVATE_KEY:-}" ]]; then
  echo "GitHub App auth: configured"
else
  echo "GitHub App auth: missing"
fi

exec npm --prefix apps/github run dev -- --env "$DEV_ENV_NAME"
