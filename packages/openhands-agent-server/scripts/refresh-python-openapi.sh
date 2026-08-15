#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${1:-}"
MANIFEST="$PACKAGE_ROOT/vendor/openhands-agent/transpile/upstream.json"
OUTPUT="$PACKAGE_ROOT/transpile/python-openapi.json"
METADATA="$PACKAGE_ROOT/transpile/python-openapi.meta.json"
GENERATOR="openhands-agent-server/openhands/agent_server/openapi.py"
BOOTSTRAP="$PACKAGE_ROOT/scripts/run-pinned-python-openapi.py"
SHIM_DESCRIPTION="openai._models.BaseModel=pydantic.BaseModel (schema-generation import only)"

if [[ -z "$UPSTREAM_DIR" ]]; then
  echo "usage: $0 /path/to/software-agent-sdk" >&2
  exit 2
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "missing canonical upstream manifest: $MANIFEST" >&2
  exit 1
fi

if [[ ! -f "$BOOTSTRAP" ]]; then
  echo "missing schema bootstrap: $BOOTSTRAP" >&2
  exit 1
fi

if [[ ! -d "$UPSTREAM_DIR/.git" ]]; then
  echo "upstream checkout is not a git repository: $UPSTREAM_DIR" >&2
  exit 1
fi

readarray -t SOURCE < <(
  node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
console.log(manifest.repository);
console.log(manifest.commit);
NODE
)

REPOSITORY="${SOURCE[0]:-}"
PIN="${SOURCE[1]:-}"
ACTUAL="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"

if [[ ! "$PIN" =~ ^[0-9a-f]{40}$ ]]; then
  echo "manifest commit is not a full SHA: $PIN" >&2
  exit 1
fi

if [[ "$ACTUAL" != "$PIN" ]]; then
  echo "upstream checkout mismatch: expected $PIN, found $ACTUAL" >&2
  exit 1
fi

if [[ ! -f "$UPSTREAM_DIR/$GENERATOR" ]]; then
  echo "pinned upstream generator not found: $UPSTREAM_DIR/$GENERATOR" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
RAW_SCHEMA="$TMP_DIR/python-openapi.json"

(
  cd "$UPSTREAM_DIR"
  # Match the pinned repository's documented development setup. The server imports
  # runtime pieces supplied by sibling workspace packages, so a server-only sync is
  # insufficient even though the schema generator itself is small.
  uv sync --locked --dev
  SCHEMA_PATH="$RAW_SCHEMA" \
    uv run --locked python "$BOOTSTRAP" "$UPSTREAM_DIR/$GENERATOR"
)

npx tsx "$PACKAGE_ROOT/scripts/canonicalize-python-openapi.ts" \
  --input "$RAW_SCHEMA" \
  --output "$OUTPUT" \
  --metadata "$METADATA" \
  --repository "$REPOSITORY" \
  --commit "$PIN" \
  --generator "$GENERATOR" \
  --compatibility-shim "$SHIM_DESCRIPTION"
