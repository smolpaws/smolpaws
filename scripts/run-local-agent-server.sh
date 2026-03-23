#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

resolve_default_vscode_settings_path() {
  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "$HOME/Library/Application Support/Code/User/settings.json"
      ;;
    Linux)
      printf '%s\n' "$HOME/.config/Code/User/settings.json"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      printf '%s\n' "$HOME/AppData/Roaming/Code/User/settings.json"
      ;;
    *)
      printf '%s\n' "$HOME/.config/Code/User/settings.json"
      ;;
  esac
}

SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
SMOLPAWS_ENV_FILE="${SMOLPAWS_ENV_FILE:-$SMOLPAWS_HOME_DIR/.env}"
if [[ -f "${SMOLPAWS_ENV_FILE}" ]]; then
  set +u
  set -a
  # shellcheck disable=SC1090
  source "${SMOLPAWS_ENV_FILE}"
  set +a
  set -u
fi

SMOLPAWS_VSCODE_SETTINGS_PATH="${SMOLPAWS_VSCODE_SETTINGS_PATH:-$(resolve_default_vscode_settings_path)}"
if [[ -z "${LLM_PROFILE_ID:-}" ]] && [[ -f "${SMOLPAWS_VSCODE_SETTINGS_PATH}" ]]; then
  detected_profile_id="$(
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      try {
        const settings = JSON.parse(fs.readFileSync(file, "utf8"));
        const value = typeof settings["openhands.llm.profileId"] === "string"
          ? settings["openhands.llm.profileId"].trim()
          : "";
        if (value) process.stdout.write(value);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[run-local] Warning: Could not read profile from ${file}: ${message}`);
      }
    ' "${SMOLPAWS_VSCODE_SETTINGS_PATH}"
  )"
  if [[ -n "${detected_profile_id}" ]]; then
    export LLM_PROFILE_ID="${detected_profile_id}"
  fi
fi

if [[ -z "${LLM_PROFILE_ID:-}" ]]; then
  echo "LLM_PROFILE_ID is required. Set it in ~/.smolpaws/.env or in VS Code user settings as openhands.llm.profileId." >&2
  exit 1
fi

export PORT="${PORT:-8788}"
export RUNNER_HOST="${RUNNER_HOST:-127.0.0.1}"
export SMOLPAWS_WORKSPACE_ROOT="${SMOLPAWS_WORKSPACE_ROOT:-$HOME/repos}"
export SMOLPAWS_DEFAULT_WORKING_DIR="${SMOLPAWS_DEFAULT_WORKING_DIR:-smolpaws}"
export SMOLPAWS_VSCODE_SETTINGS_PATH

runner_host_lc="$(printf '%s' "${RUNNER_HOST}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "${SMOLPAWS_RUNNER_TOKEN:-}" ]] && [[ "${runner_host_lc}" != "127.0.0.1" ]] && [[ "${runner_host_lc}" != "localhost" ]] && [[ "${runner_host_lc}" != "::1" ]]; then
  echo "SMOLPAWS_RUNNER_TOKEN is required when RUNNER_HOST is non-localhost (${RUNNER_HOST})." >&2
  exit 1
fi

echo "Starting smolpaws agent-server on http://${RUNNER_HOST}:${PORT}"
echo "Health: curl http://${RUNNER_HOST}:${PORT}/health"
echo "Active LLM profile: ${LLM_PROFILE_ID}"
echo "Allowed workspace root: ${SMOLPAWS_WORKSPACE_ROOT}"
echo "Default startup working directory: ${SMOLPAWS_DEFAULT_WORKING_DIR}"
echo "VS Code settings path: ${SMOLPAWS_VSCODE_SETTINGS_PATH}"
if [[ -f "${SMOLPAWS_ENV_FILE}" ]]; then
  echo "Loaded env file: ${SMOLPAWS_ENV_FILE}"
fi
if [[ -n "${SMOLPAWS_RUNNER_TOKEN:-}" ]]; then
  echo "Runner auth: enabled"
else
  echo "Runner auth: disabled"
fi

exec npm run runner:start
