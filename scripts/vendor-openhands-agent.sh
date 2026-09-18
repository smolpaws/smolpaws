#!/usr/bin/env bash
#
# Re-vendor the TypeScript OpenHands SDK (@smolpaws/openhands-agent) into
# packages/openhands-agent-server/vendor/openhands-agent from a local checkout
# of the SDK repository.
#
# The vendored package is the *built* npm package (dist + transpile manifest),
# produced with `npm pack` so what we vendor is exactly what `npm publish`
# would ship. Provenance is recorded in the vendored package.json as
# `_smolpawsProvenance: { source, gitCommit }`; the upstream OpenHands pin is
# NOT duplicated there — vendor/openhands-agent/transpile/upstream.json is
# canonical (scripts/check-upstream-provenance.ts enforces both rules).
#
# Usage:
#   scripts/vendor-openhands-agent.sh /path/to/openhands-agent [--skip-sdk-checks]
#
# Steps performed:
#   1. verify the SDK checkout is a clean git worktree; record its HEAD SHA
#   2. `npm ci` in the SDK, then (unless --skip-sdk-checks) `npm test`,
#      `npm run typecheck`, `npm run lint`
#   3. `npm run build` and `npm pack` the SDK
#   4. replace vendor/openhands-agent/{dist,transpile/upstream.json,
#      transpile/updates/*.inventory.json,package.json}
#   5. refresh the server lockfile for the changed file: package dependencies,
#      then `npm ci` and `npm run test:upstream-provenance`
#
# Nothing is committed. Review `git status` and commit with a message like:
#   re-vendor agent-server SDK <OLD8>..<NEW8> (vX.Y.Z -> vA.B.C)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/packages/openhands-agent-server"
VENDOR_DIR="$PACKAGE_DIR/vendor/openhands-agent"

SDK_DIR="${1:-}"
SKIP_SDK_CHECKS=0
for arg in "${@:2}"; do
  case "$arg" in
    --skip-sdk-checks) SKIP_SDK_CHECKS=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$SDK_DIR" ]] || ! git -C "$SDK_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "usage: $0 /path/to/openhands-agent [--skip-sdk-checks]" >&2
  exit 2
fi
SDK_DIR="$(cd "$SDK_DIR" && pwd)"

if [[ -n "$(git -C "$SDK_DIR" status --porcelain)" ]]; then
  echo "SDK checkout has uncommitted changes; vendor only committed state: $SDK_DIR" >&2
  exit 1
fi

SDK_COMMIT="$(git -C "$SDK_DIR" rev-parse HEAD)"
SDK_REMOTE="$(git -C "$SDK_DIR" remote get-url origin 2>/dev/null || printf 'unknown')"
SDK_SOURCE="$(printf '%s' "$SDK_REMOTE" | sed -E 's#^(https?://|git@)##; s#^github.com[:/]#github.com/#; s#\.git$##')"

echo "Vendoring @smolpaws/openhands-agent from $SDK_SOURCE@$SDK_COMMIT" >&2

(
  cd "$SDK_DIR"
  npm ci --no-audit --no-fund
  if [[ "$SKIP_SDK_CHECKS" -eq 0 ]]; then
    npm test
    npm run typecheck
    npm run lint
  fi
  npm run build
)

PACK_DIR="$(mktemp -d)"
trap 'rm -rf "$PACK_DIR"' EXIT
(
  cd "$SDK_DIR"
  npm pack --pack-destination "$PACK_DIR" >/dev/null
)
TARBALL="$(ls "$PACK_DIR"/*.tgz | head -n 1)"
tar -xzf "$TARBALL" -C "$PACK_DIR"
PACKED="$PACK_DIR/package"

test -d "$PACKED/dist" || { echo "packed SDK has no dist/" >&2; exit 1; }
test -f "$PACKED/transpile/upstream.json" || { echo "packed SDK has no transpile/upstream.json" >&2; exit 1; }
test -d "$PACKED/transpile/updates" || { echo "packed SDK has no transpile/updates (interval inventories)" >&2; exit 1; }

OLD_PIN="$(node -p "require('$VENDOR_DIR/transpile/upstream.json').commit" 2>/dev/null || printf 'none')"
NEW_PIN="$(node -p "require('$PACKED/transpile/upstream.json').commit")"

rm -rf "$VENDOR_DIR/dist" "$VENDOR_DIR/transpile"
mkdir -p "$VENDOR_DIR/transpile"
cp -R "$PACKED/dist" "$VENDOR_DIR/dist"
cp "$PACKED/transpile/upstream.json" "$VENDOR_DIR/transpile/upstream.json"
# Interval inventories are the review list for transpile/updates/<from8>..<to8>.json in this package
# (scripts/check-server-review.ts walks them from transpile/server-reviews.json#since to the new pin).
mkdir -p "$VENDOR_DIR/transpile/updates"
cp "$PACKED"/transpile/updates/*.inventory.json "$VENDOR_DIR/transpile/updates/"

node - "$PACKED/package.json" "$VENDOR_DIR/package.json" "$SDK_SOURCE" "$SDK_COMMIT" <<'NODE'
const fs = require('node:fs');
const [packedPath, outPath, source, gitCommit] = process.argv.slice(2);
const packed = JSON.parse(fs.readFileSync(packedPath, 'utf8'));
const keep = ['name', 'version', 'description', 'license', 'type', 'main', 'module', 'types', 'exports', 'dependencies', 'sideEffects'];
const out = {};
for (const key of keep) if (packed[key] !== undefined) out[key] = packed[key];
// `files` is rewritten: the vendored copy publishes only what we copied.
const ordered = {};
for (const key of ['name', 'version', 'description', 'license', 'type', 'main', 'module', 'types', 'exports']) {
  if (out[key] !== undefined) ordered[key] = out[key];
}
ordered.files = ['dist', 'transpile'];
for (const key of ['dependencies', 'sideEffects']) if (out[key] !== undefined) ordered[key] = out[key];
ordered._smolpawsProvenance = { source, gitCommit };
fs.writeFileSync(outPath, `${JSON.stringify(ordered, null, 2)}\n`);
NODE

echo "Vendored SDK: upstream pin $OLD_PIN -> $NEW_PIN" >&2

(
  cd "$PACKAGE_DIR"
  # A new packed SDK can add runtime dependencies without changing the file: URL.
  # Resolve that deliberate package replacement into the committed lock before ci.
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund
  npm ci --no-audit --no-fund
  npm run test:upstream-provenance
  # Fails until transpile/updates/<OLD8>..<NEW8>.json exists for every new interval: that is the review.
  npm run test:server-review || echo "server review records are missing for the new interval(s); write them next (docs/REVENDOR_AUTOMATION.md, step 2)" >&2
)

echo "Done. Review with: git -C '$ROOT_DIR' status -- packages/openhands-agent-server/vendor" >&2
