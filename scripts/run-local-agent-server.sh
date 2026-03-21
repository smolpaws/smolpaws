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

echo "Starting smolpaws agent-server on http://localhost:${PORT}"
echo "Health: curl http://localhost:${PORT}/health"
if [[ -n "${SMOLPAWS_RUNNER_TOKEN:-}" ]]; then
  echo "Runner auth: enabled"
else
  echo "Runner auth: disabled"
fi

exec npm run runner:start
