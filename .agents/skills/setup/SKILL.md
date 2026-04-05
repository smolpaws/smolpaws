---
name: setup
description: Run initial SmolPaws setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure smolpaws", or first-time setup requests.
---

# SmolPaws Setup

Run all commands automatically. Only pause when user action is required (scanning QR codes).

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> SmolPaws needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Apple Container** (default) - macOS-native, lightweight, designed for Apple silicon
> 2. **Docker** - Cross-platform, widely used, works on macOS and Linux
>
> Which would you prefer?

#### Option A: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

**Note:** SmolPaws automatically starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Tell the user:
> You've chosen Docker. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

## 3. Configure OpenHands LLM Access

SmolPaws uses OpenHands LLM profiles. The local launchers read secrets from `~/.smolpaws/.env` and resolve the active profile from either `LLM_PROFILE_ID` or the VS Code user setting `openhands.llm.profileId`.

Prepare the local env file if none exists:

```bash
mkdir -p ~/.smolpaws
touch ~/.smolpaws/.env
```

Ask the user:
> Do you already have a working OpenHands LLM profile selected in VS Code, or do you want to set `LLM_PROFILE_ID` manually in `~/.smolpaws/.env`?

If they want to set it manually, add it:

```bash
printf 'LLM_PROFILE_ID=YOUR_PROFILE_ID\n' >> ~/.smolpaws/.env
```

Then make sure the provider key required by that profile is present in `~/.smolpaws/.env`.

Common examples:
- `OPENAI_API_KEY=...`
- `ANTHROPIC_API_KEY=...`
- `GEMINI_API_KEY=...`

If they already have a key elsewhere and want to copy it in:

```bash
grep -E '^(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)=' /path/to/source/.env >> ~/.smolpaws/.env
```

If they need to add one manually, create the line they need and let them fill in the value:

```bash
echo 'OPENAI_API_KEY=' >> ~/.smolpaws/.env
```

Verify without printing secrets:

```bash
node - <<'EOF'
const fs = require('fs');
const path = require('path');
const envPath = path.join(process.env.HOME, '.smolpaws', '.env');
const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const names = raw.split(/\r?\n/)
  .map((line) => line.match(/^([A-Z0-9_]+)=/))
  .filter(Boolean)
  .map((match) => match[1]);
console.log(`Env file: ${envPath}`);
console.log(`Configured keys: ${names.join(', ') || 'none'}`);
EOF
```

## 4. Build Runner Image

Build the shared SmolPaws runner image from `apps/agent-server`:

```bash
npm run runner:image:build
```

This creates the `smolpaws-runner:latest` image used by the shared Fastify agent-server runner surface.

Verify the build succeeded by running a simple test (this auto-detects which runtime you're using):

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --entrypoint /bin/echo smolpaws-runner:latest "Runner OK" || echo "Runner image build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo smolpaws-runner:latest "Runner OK" || echo "Runner image build failed"
fi
```

## 5. WhatsApp Authentication

**USER ACTION REQUIRED**

Run the authentication script:

```bash
npm run auth
```

Tell the user:
> A QR code will appear. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.

## 6. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `smolpaws`)
>
> Messages starting with `@TriggerWord` will be sent to SmolPaws.

Persist the chosen name in `~/.smolpaws/.env`:

```bash
python3 - <<'PY'
from pathlib import Path
import os

env_path = Path(os.path.expanduser('~/.smolpaws/.env'))
env_path.parent.mkdir(parents=True, exist_ok=True)
name = 'YOUR_ASSISTANT_NAME'
lines = []
if env_path.exists():
    lines = [line for line in env_path.read_text().splitlines() if not line.startswith('ASSISTANT_NAME=')]
lines.append(f'ASSISTANT_NAME={name}')
env_path.write_text('\n'.join(lines) + '\n')
PY
```

If they want the in-chat persona docs to match the trigger name, also update:
1. `groups/global/AGENTS.md` - Change `# smolpaws` and `You are smolpaws` to the new name
2. `groups/main/AGENTS.md` - Same changes at the top
3. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups

Store their choice - you'll use it when creating `data/registered_groups.json` and when telling them how to test.

## 7. Register Main Channel

Ask the user:
> Do you want to use your **personal chat** (message yourself) or a **WhatsApp group** as your main control channel?

For personal chat:
> Send any message to yourself in WhatsApp (the "Message Yourself" chat). Tell me when done.

For group:
> Send any message in the WhatsApp group you want to use as your main channel. Tell me when done.

After user confirms, start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the JID from the database:

```bash
# For personal chat (ends with @s.whatsapp.net)
sqlite3 ~/.smolpaws/whatsapp/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@s.whatsapp.net' ORDER BY timestamp DESC LIMIT 5"

# For group (ends with @g.us)
sqlite3 ~/.smolpaws/whatsapp/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@g.us' ORDER BY timestamp DESC LIMIT 5"
```

Create/update `data/registered_groups.json` using the JID from above and the assistant name from step 6:
```json
{
  "JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 8. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the SmolPaws project?
>
> Examples: Git repositories, project folders, documents you want SmolPaws to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/smolpaws
cat > ~/.config/smolpaws/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask follow-up questions:

### 8a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?
>
> Read-write is needed for: code changes, creating files, git commits
> Read-only is safer for: reference docs, config examples, templates

### 8b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other WhatsApp chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 8c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/smolpaws
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/smolpaws/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/docs",
      "allowReadWrite": false,
      "description": "Reference documents"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

Verify the file:

```bash
cat ~/.config/smolpaws/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the SmolPaws service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app", "containerPath": "my-app", "readonly": false }
>   ]
> }
> ```

## 9. Install Local Service

### macOS

Build the app and install the checked-in LaunchAgent:

```bash
npm run build
npm run smolpaws:launchagent:install
```

If the user also wants heartbeat ingress enabled locally, install that too:

```bash
npm run heartbeat:launchagent:install
```

Verify both services:

```bash
launchctl list | grep smolpaws
```

### Linux / other

This repo does not ship a checked-in systemd unit yet. For now, run SmolPaws in the foreground while testing:

```bash
npm run dev
```

## 10. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.

If using the macOS LaunchAgent, check the logs:
```bash
tail -f ~/.smolpaws/logs/smolpaws.launchagent.log
```

If running in the foreground, watch the terminal output instead.

The user should receive a response in WhatsApp.

## Troubleshooting

**Service not starting**: Check `~/.smolpaws/logs/smolpaws.launchagent.error.log` if using the LaunchAgent.

**Runner exits early (including Runner process exited with code 1)**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check workspace logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (for example `@AssistantName` at the start of the message)
- Check that the chat JID is in `data/registered_groups.json`
- Check `~/.smolpaws/logs/smolpaws.launchagent.log` if using the LaunchAgent, or the terminal output if running interactively

**WhatsApp disconnected**:
- The LaunchAgent path will show a macOS notification
- Run `npm run auth` to re-authenticate
- Restart the service with `launchctl kickstart -k gui/$(id -u)/com.smolpaws` on macOS, or restart `npm run dev` if running interactively

**Remove macOS LaunchAgent**:
```bash
npm run smolpaws:launchagent:remove
```
