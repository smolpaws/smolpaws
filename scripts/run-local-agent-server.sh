#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${LLM_MODEL:-}" ]]; then
  echo "LLM_MODEL is required. Example: LLM_MODEL=openai/gpt-5.4" >&2
  exit 1
fi

if [[ -z "${LLM_API_KEY:-}" ]]; then
  case "${LLM_MODEL}" in
    openai/*|gpt-*|o[1-9]*)
      if [[ -n "${OPENAI_API_KEY:-}" ]]; then
        export LLM_API_KEY="${OPENAI_API_KEY}"
      fi
      ;;
    anthropic/*|claude*)
      if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        export LLM_API_KEY="${ANTHROPIC_API_KEY}"
      fi
      ;;
    *)
      if [[ -n "${OPENAI_API_KEY:-}" ]]; then
        export LLM_API_KEY="${OPENAI_API_KEY}"
      elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        export LLM_API_KEY="${ANTHROPIC_API_KEY}"
      fi
      ;;
  esac
fi

if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "LLM_API_KEY is required. You can also set OPENAI_API_KEY or ANTHROPIC_API_KEY and this script will map it." >&2
  exit 1
fi

export PORT="${PORT:-8788}"
export RUNNER_HOST="${RUNNER_HOST:-127.0.0.1}"
export SMOLPAWS_WORKSPACE_ROOT="${SMOLPAWS_WORKSPACE_ROOT:-$HOME/repos}"
export SMOLPAWS_DEFAULT_WORKING_DIR="${SMOLPAWS_DEFAULT_WORKING_DIR:-smolpaws}"

runner_host_lc="$(printf '%s' "${RUNNER_HOST}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "${SMOLPAWS_RUNNER_TOKEN:-}" ]] && [[ "${runner_host_lc}" != "127.0.0.1" ]] && [[ "${runner_host_lc}" != "localhost" ]] && [[ "${runner_host_lc}" != "::1" ]]; then
  echo "SMOLPAWS_RUNNER_TOKEN is required when RUNNER_HOST is non-localhost (${RUNNER_HOST})." >&2
  exit 1
fi

echo "Starting smolpaws agent-server on http://${RUNNER_HOST}:${PORT}"
echo "Health: curl http://${RUNNER_HOST}:${PORT}/health"
echo "Allowed workspace root: ${SMOLPAWS_WORKSPACE_ROOT}"
echo "Default startup working directory: ${SMOLPAWS_DEFAULT_WORKING_DIR}"
if [[ -n "${SMOLPAWS_RUNNER_TOKEN:-}" ]]; then
  echo "Runner auth: enabled"
else
  echo "Runner auth: disabled"
fi

exec npm run runner:start
