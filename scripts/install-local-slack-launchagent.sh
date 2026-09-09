#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
AGENT_LABEL="com.smolpaws.slack"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/${AGENT_LABEL}.plist"
TEMPLATE_PLIST="${ROOT_DIR}/launchd/${AGENT_LABEL}.plist"
LOG_DIR="${SMOLPAWS_HOME_DIR}/logs"
PATH_VALUE="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

python3 - <<'PY' "${TEMPLATE_PLIST}" "${TARGET_PLIST}" "${ROOT_DIR}" "${HOME}" "${SMOLPAWS_HOME_DIR}" "${LOG_DIR}" "${PATH_VALUE}"
from pathlib import Path
import sys
from xml.sax.saxutils import escape

template_path, target_path, project_root, home, smolpaws_home, log_dir, path_value = sys.argv[1:]
content = Path(template_path).read_text()
for key, value in {
    '{{PROJECT_ROOT}}': project_root,
    '{{HOME}}': home,
    '{{SMOLPAWS_HOME_DIR}}': smolpaws_home,
    '{{LOG_DIR}}': log_dir,
    '{{PATH}}': path_value,
}.items():
    content = content.replace(key, escape(value))
Path(target_path).write_text(content)
PY

launchctl bootout "gui/$(id -u)" "${TARGET_PLIST}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${TARGET_PLIST}"
launchctl enable "gui/$(id -u)/${AGENT_LABEL}"
launchctl kickstart -k "gui/$(id -u)/${AGENT_LABEL}"

echo "Installed SmolPaws Slack Relay LaunchAgent:"
echo "  Plist: ${TARGET_PLIST}"
echo "  Logs:  ${LOG_DIR}/slack-relay.launchagent.{log,error.log}"
