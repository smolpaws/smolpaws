#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/com.smolpaws.heartbeat.plist"
TEMPLATE_PLIST="${ROOT_DIR}/launchd/com.smolpaws.heartbeat.plist"
LOG_DIR="${SMOLPAWS_HOME_DIR}/logs"
PATH_VALUE="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

python3 - <<'PY' "${TEMPLATE_PLIST}" "${TARGET_PLIST}" "${ROOT_DIR}" "${HOME}" "${SMOLPAWS_HOME_DIR}" "${LOG_DIR}" "${PATH_VALUE}"
from pathlib import Path
import sys

template_path, target_path, project_root, home, smolpaws_home, log_dir, path_value = sys.argv[1:]
content = Path(template_path).read_text()
for key, value in {
    '{{PROJECT_ROOT}}': project_root,
    '{{HOME}}': home,
    '{{SMOLPAWS_HOME_DIR}}': smolpaws_home,
    '{{LOG_DIR}}': log_dir,
    '{{PATH}}': path_value,
}.items():
    content = content.replace(key, value)
Path(target_path).write_text(content)
PY

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${TARGET_PLIST}"
launchctl enable "gui/$(id -u)/com.smolpaws.heartbeat"

echo "Installed SmolPaws heartbeat LaunchAgent:"
echo "${TARGET_PLIST}"
echo "Schedule: every 60 minutes"
