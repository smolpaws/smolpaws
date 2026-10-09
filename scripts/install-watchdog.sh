#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/com.smolpaws.watchdog.plist"
mkdir -p "$HOME/Library/LaunchAgents"
# plistlib escapes paths correctly. Launchd stdout is discarded; the script atomically
# replaces its small private status files rather than accumulating unbounded logs.
python3 - "$ROOT_DIR" "$TARGET" <<'PYTHON'
import plistlib,sys,pathlib,shutil,os
root,target=map(pathlib.Path,sys.argv[1:])
home=pathlib.Path(os.environ.get('SMOLPAWS_HOME_DIR',str(pathlib.Path.home()/'.smolpaws')))
runtime=home/'watchdog/runtime'
stage=home/'watchdog/runtime.new'
previous=home/'watchdog/runtime.previous'
if stage.exists(): shutil.rmtree(stage)
stage.mkdir(parents=True,mode=0o700)
files=['scripts/watchdog.ts','scripts/run-watchdog.sh','scripts/run-local-smolpaws.sh',
       'src/watchdog/policy.ts','src/whatsapp-owner.ts','src/shared/jev.ts',
       'src/shared/keychain.ts','src/shared/relayConversationDefaults.ts','src/shared/smolpawsContext.ts',
       'apps/agent-server/src/agent-server/heartbeat.ts']
for name in files:
    dest=stage/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,dest)
(stage/'package.json').write_text('{"type":"module"}\n')
(stage/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
if previous.exists(): shutil.rmtree(previous)
if runtime.exists(): runtime.rename(previous)
stage.rename(runtime)
data={'Label':'com.smolpaws.watchdog','ProgramArguments':['/bin/bash',str(runtime/'scripts/run-watchdog.sh'),'check'],
'WorkingDirectory':str(runtime),'StartInterval':3600,'RunAtLoad':False,
'ProcessType':'Background','StandardOutPath':'/dev/null','StandardErrorPath':'/dev/null',
'EnvironmentVariables':{'HOME':str(pathlib.Path.home()),'SMOLPAWS_HOME_DIR':str(home),
'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}}
target.write_bytes(plistlib.dumps(data))
PYTHON
launchctl bootout "gui/$(id -u)/com.smolpaws.watchdog" >/dev/null 2>&1 || true
launchctl enable "gui/$(id -u)/com.smolpaws.watchdog"
launchctl bootstrap "gui/$(id -u)" "$TARGET"
echo 'Installed hourly watchdog. Status: bash scripts/run-watchdog.sh status'
