# SmolPaws Specification

A personal Claude assistant accessible via WhatsApp, with persistent memory per conversation, scheduled tasks, and email integration.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS)                                  │
│                   (Main Node.js Process)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │  WhatsApp    │────────────────────▶│   SQLite Database  │        │
│  │  (baileys)   │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Message Loop    │    │  Scheduler Loop  │    │  IPC Watcher  │  │
│  │  (polls SQLite)  │    │  (checks tasks)  │    │  (file-based) │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ spawns container                             │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                  APPLE CONTAINER (Linux VM)                          │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER                               │   │
│  │                                                                │   │
│  │  Working directory: /workspace/group (mounted from host)       │   │
│  │  Volume mounts:                                                │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/ (non-main only)        │   │
│  │    • data/sessions/{group}/.claude/ → /home/node/.claude/      │   │
│  │    • Additional dirs → /workspace/extra/*                      │   │
│  │                                                                │   │
│  │  Tools (all groups):                                           │   │
│  │    • Bash (safe - sandboxed in container!)                     │   │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │   │
│  │    • WebSearch, WebFetch (internet access)                     │   │
│  │    • agent-browser (browser automation)                        │   │
│  │    • * (scheduler tools via IPC)                │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp Connection | Node.js (@whiskeysockets/baileys) | Connect to WhatsApp, send/receive messages |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling |
| Container Runtime | Apple Container | Isolated Linux VMs for agent execution |
| Agent | `@smolpaws/agent-sdk` (published npm package) | Shared TypeScript agent runtime, tools, and conversation orchestration |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 20+ | Host process for routing and scheduling |

Canonical runtime ownership note:
- The shared TypeScript runtime is owned in `enyst/OpenHands-Tab/packages/agent-sdk`.
- This repo consumes the published `@smolpaws/agent-sdk` package through its AppleWorkspace-managed runner surface rather than maintaining a repo-local runtime fork.

---

## Folder Structure

```
smolpaws/
├── AGENTS.md                      # Project context for agents
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Main application (WhatsApp + routing)
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces
│   ├── utils.ts                   # Generic utility functions
│   ├── db.ts                      # Database initialization and queries
│   ├── whatsapp-auth.ts           # Standalone WhatsApp authentication
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   └── agent-runtime/
│       ├── shared-runner.ts       # AppleWorkspace-backed runner client
│       ├── workspace.ts           # Per-scope mount policy
│       └── types.ts               # Runtime request/response types
│
├── apps/
│   └── agent-server/              # Shared Fastify agent-server app + runner image
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── .claude/
│   └── skills/
│       ├── setup/
│       │   └── SKILL.md           # /setup skill
│       ├── customize/
│       │   └── SKILL.md           # /customize skill
│       └── debug/
│           └── SKILL.md           # /debug skill (container debugging)
│
├── groups/
│   ├── AGENTS.md                  # Global memory (all groups read this)
│   ├── main/                      # Self-chat (main control channel)
│   │   ├── AGENTS.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {Group Name}/              # Per-group folders (created on registration)
│       ├── AGENTS.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite database (messages, scheduled_tasks, task_run_logs)
│
├── data/                          # Application state (gitignored)
│   ├── sessions.json              # Active session IDs per group
│   ├── registered_groups.json     # Group JID → folder mapping
│   ├── router_state.json          # Last processed timestamp + last agent timestamps
│   └── runner-conversations/      # Per-scope runner persistence roots
│
├── logs/                          # Runtime logs (gitignored)
│   ├── smolpaws.log               # Host stdout
│   └── smolpaws.error.log         # Host stderr
│   # Note: Per-container logs are in groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.smolpaws.plist         # macOS service configuration
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Paths are absolute (required for container mounts)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const TRIGGER_PATTERN = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
```

**Note:** Paths must be absolute for Apple Container volume mounts to work correctly.

### Container Configuration

Groups can have additional directories mounted via `containerConfig` in `data/registered_groups.json`:

```json
{
  "1234567890@g.us": {
    "name": "Dev Team",
    "folder": "dev-team",
    "trigger": "@smolpaws",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/Users/gavriel/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ],
      "timeout": 600000
    }
  }
}
```

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container.

**Apple Container mount syntax note:** Read-write mounts use `-v host:container`, but readonly mounts require `--mount "type=bind,source=...,target=...,readonly"` (the `:ro` suffix doesn't work).

### Claude Authentication

Configure authentication in a `.env` file in the project root. Two options:

**Option 1: Claude Subscription (OAuth token)**
```bash
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```
The token can be extracted from `~/.claude/.credentials.json` if you're logged in to Claude Code.

**Option 2: Pay-per-use API Key**
```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

The shared runner forwards the required model/auth environment into the per-scope AppleWorkspace host. The agent-server implementation and runner image source now live under `apps/agent-server`. The older stdin-entrypoint `.env` mount workaround is no longer part of the active runtime path.

### Changing the Assistant Name

Set the `ASSISTANT_NAME` environment variable:

```bash
ASSISTANT_NAME=Bot npm start
```

Or edit the default in `src/config.ts`. This changes:
- The trigger pattern (messages must start with `@YourName`)
- The response prefix (`YourName:` added automatically)

### Placeholder Values in launchd

Files with `{{PLACEHOLDER}}` values need to be configured:
- `{{PROJECT_ROOT}}` - Absolute path to your smolpaws installation
- `{{NODE_PATH}}` - Path to node binary (detected via `which node`)
- `{{HOME}}` - User's home directory

---

## Memory System

SmolPaws uses a hierarchical memory system based on AGENTS.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/AGENTS.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/AGENTS.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - OpenHands Agent SDK automatically loads:
     - `../AGENTS.md` (parent directory = global memory)
     - `./AGENTS.md` (current directory = group memory)

2. **Writing Memory**
   - When user says "remember this", agent writes to `./AGENTS.md`
   - When user says "remember this globally" (main channel only), agent writes to `../AGENTS.md`
   - Agent can create files like `notes.md`, `research.md` in the group folder

3. **Main Channel Privileges**
   - Only the "main" group (self-chat) can write to global memory
   - Main can manage registered groups and schedule tasks for any group
   - Main can configure additional directory mounts for any group
   - All groups have Bash access (safe because it runs inside container)

---

## Session Management

Sessions enable conversation continuity - Claude remembers what you talked about.

### How Sessions Work

1. Each group has a session ID stored in `data/sessions.json`
2. Session ID is passed to `@smolpaws/agent-sdk`'s `resume` option
3. Claude continues the conversation with full context

**data/sessions.json:**
```json
{
  "main": "session-abc123",
  "Family Chat": "session-def456"
}
```

---

## Message Flow

### Incoming Message Flow

```
1. User sends WhatsApp message
   │
   ▼
2. Baileys receives message via WhatsApp Web protocol
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Is chat_jid in registered_groups.json? → No: ignore
   └── Does message start with @Assistant? → No: ignore
   │
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
7. Router invokes `@smolpaws/agent-sdk`:
   ├── cwd: groups/{group-name}/
   ├── prompt: conversation history + current message
   ├── resume: session_id (for continuity)
   └── mcpServers: smolpaws (scheduler)
   │
   ▼
8. Claude processes message:
   ├── Reads AGENTS.md files for context
   └── Uses tools as needed (search, email, etc.)
   │
   ▼
9. Router prefixes response with assistant name and sends via WhatsApp
   │
   ▼
10. Router updates last agent timestamp and saves session ID
```

### Trigger Word Matching

Messages must start with the trigger pattern (default: `@smolpaws`):
- `@smolpaws what's the weather?` → ✅ Triggers Claude
- `@andy help me` → ✅ Triggers (case insensitive)
- `Hey @smolpaws` → ❌ Ignored (trigger not at start)
- `What's up?` → ❌ Ignored (no trigger)

### Conversation Catch-Up

When a triggered message arrives, the agent receives all messages since its last interaction in that chat. Each message is formatted with timestamp and sender name:

```
[Jan 31 2:32 PM] John: hey everyone, should we do pizza tonight?
[Jan 31 2:33 PM] Sarah: sounds good to me
[Jan 31 2:35 PM] John: @smolpaws what toppings do you recommend?
```

This allows the agent to understand the conversation context even if it wasn't mentioned in every message.

---

## Commands

### Commands Available in Any Group

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant [message]` | `@smolpaws what's the weather?` | Talk to Claude |

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group "Name"` | `@smolpaws add group "Family Chat"` | Register a new group |
| `@Assistant remove group "Name"` | `@smolpaws remove group "Work Team"` | Unregister a group |
| `@Assistant list groups` | `@smolpaws list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@smolpaws remember I prefer dark mode` | Add to global memory |

---

## Scheduled Tasks

SmolPaws has a built-in scheduler that runs tasks as full agents in their group's context.

### How Scheduling Works

1. **Group Context**: Tasks created in a group run with that group's working directory and memory
2. **Full Agent Capabilities**: Scheduled tasks have access to all tools (WebSearch, file operations, etc.)
3. **Optional Messaging**: Tasks can send messages to their group using the `send_message` tool, or complete silently
4. **Main Channel Privileges**: The main channel can schedule tasks for any group and view all tasks

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO timestamp | `2024-12-25T09:00:00Z` |

### Creating a Task

```
User: @smolpaws remind me every Monday at 9am to review the weekly metrics

Claude: [calls schedule_task]
        {
          "prompt": "Send a reminder to review weekly metrics. Be encouraging!",
          "schedule_type": "cron",
          "schedule_value": "0 9 * * 1"
        }

Claude: Done! I'll remind you every Monday at 9am.
```

### One-Time Tasks

```
User: @smolpaws at 5pm today, send me a summary of today's emails

Claude: [calls schedule_task]
        {
          "prompt": "Search for today's emails, summarize the important ones, and send the summary to the group.",
          "schedule_type": "once",
          "schedule_value": "2024-01-31T17:00:00Z"
        }
```

### Managing Tasks

From any group:
- `@smolpaws list my scheduled tasks` - View tasks for this group
- `@smolpaws pause task [id]` - Pause a task
- `@smolpaws resume task [id]` - Resume a paused task
- `@smolpaws cancel task [id]` - Delete a task

From main channel:
- `@smolpaws list all tasks` - View tasks from all groups
- `@smolpaws schedule task for "Family Chat": [prompt]` - Schedule for another group

---

## MCP Servers

### SmolPaws MCP (built-in)

The `smolpaws` MCP server is created dynamically per agent call with the current group's context.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks (group's tasks, or all if main) |
| `get_task` | Get task details and run history |
| `update_task` | Modify task prompt or schedule |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `send_message` | Send a WhatsApp message to the group |

---

## Deployment

SmolPaws runs as a single macOS launchd service.

### Startup Sequence

When SmolPaws starts, it:
1. **Ensures Apple Container system is running** - Automatically starts it if needed (survives reboots)
2. Initializes the SQLite database
3. Loads state (registered groups, sessions, router state)
4. Connects to WhatsApp
5. Starts the message polling loop
6. Starts the scheduler loop
7. Provisions or reuses per-scope runner containers through the shared local runtime surface

### Service: com.smolpaws

**launchd/com.smolpaws.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.smolpaws</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Andy</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/smolpaws.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/smolpaws.error.log</string>
</dict>
</plist>
```

### Managing the Service

```bash
# Install service
cp launchd/com.smolpaws.plist ~/Library/LaunchAgents/

# Start service
launchctl load ~/Library/LaunchAgents/com.smolpaws.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.smolpaws.plist

# Check status
launchctl list | grep smolpaws

# View logs
tail -f logs/smolpaws.log
```

---

## Security Considerations

### Container Isolation

All agents run inside Apple Container (lightweight Linux VMs), providing:
- **Filesystem isolation**: Agents can only access mounted directories
- **Safe Bash access**: Commands run inside the container, not on your Mac
- **Network isolation**: Can be configured per-container if needed
- **Process isolation**: Container processes can't affect the host
- **Non-root user**: Container runs as unprivileged `node` user (uid 1000)

### Prompt Injection Risk

WhatsApp messages could contain malicious instructions attempting to manipulate Claude's behavior.

**Mitigations:**
- Container isolation limits blast radius
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Agents can only access their group's mounted directories
- Main can configure additional directories per group
- Claude's built-in safety training

**Recommendations:**
- Only register trusted groups
- Review additional directory mounts carefully
- Review scheduled tasks periodically
- Monitor logs for unusual activity

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| Claude CLI Auth | data/sessions/{group}/.claude/ | Per-group isolation, mounted to /home/node/.claude/ |
| WhatsApp Session | store/auth/ | Auto-created, persists ~20 days |

### File Permissions

The groups/ folder contains personal memory and should be protected:
```bash
chmod 700 groups/
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list | grep smolpaws` |
| "Claude Code process exited with code 1" | Apple Container failed to start | Check logs; SmolPaws auto-starts container system but may fail |
| "Claude Code process exited with code 1" | Session mount path wrong | Ensure mount is to `/home/node/.claude/` not `/root/.claude/` |
| Session not continuing | Session ID not saved | Check `data/sessions.json` |
| Session not continuing | Mount path mismatch | Container user is `node` with HOME=/home/node; sessions must be at `/home/node/.claude/` |
| "QR code expired" | WhatsApp session expired | Delete store/auth/ and restart |
| "No groups registered" | Haven't added groups | Use `@smolpaws add group "Name"` in main |

### Log Location

- `logs/smolpaws.log` - stdout
- `logs/smolpaws.error.log` - stderr

### Debug Mode

Run manually for verbose output:
```bash
npm run dev
# or
node dist/index.js
```
