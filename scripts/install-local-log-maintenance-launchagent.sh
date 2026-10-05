#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "LaunchAgents are macOS only." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOLPAWS_HOME_DIR="${SMOLPAWS_HOME_DIR:-$HOME/.smolpaws}"
PYTHON="$(command -v python3)"
SMOLPAWS_HOME_DIR="$("$PYTHON" -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).expanduser().resolve())' "$SMOLPAWS_HOME_DIR")"
LABEL="com.smolpaws.log-maintenance"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
SCRIPT="${SMOLPAWS_HOME_DIR}/bin/maintain-local-logs.py"
mkdir -p "${HOME}/Library/LaunchAgents" "${SMOLPAWS_HOME_DIR}/bin" "${SMOLPAWS_HOME_DIR}/logs"

# Install a private copy so a temporary checkout or future branch switch cannot
# change the running policy. Reinstall explicitly when updating the helper.
"$PYTHON" - "$ROOT_DIR" "$TARGET_PLIST" "$SCRIPT" "$SMOLPAWS_HOME_DIR" "$PYTHON" <<'PY'
import os
from pathlib import Path
import plistlib
import sys
import tempfile

root, target, script, home, python = sys.argv[1:]
root = Path(root)

def replace_file(destination, contents, mode):
    fd, temporary = tempfile.mkstemp(prefix='.log-maintenance-install-', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), mode)
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

template = plistlib.loads((root / 'launchd/com.smolpaws.log-maintenance.plist').read_bytes())
values = {'{{PYTHON}}': python, '{{SCRIPT}}': script, '{{SMOLPAWS_HOME_DIR}}': home}
template['ProgramArguments'] = [values.get(value, value) for value in template['ProgramArguments']]
replace_file(Path(script), (root / 'scripts/maintain-local-logs.py').read_bytes(), 0o700)
replace_file(Path(target), plistlib.dumps(template), 0o600)
PY

plutil -lint "${TARGET_PLIST}"
launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
launchctl enable "gui/$(id -u)/${LABEL}"
launchctl bootstrap "gui/$(id -u)" "${TARGET_PLIST}"
echo "Installed ${LABEL}: 30-second checks, 10 MiB threshold, one 200 KB tail per server log."
