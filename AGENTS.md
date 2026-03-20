# SmolPaws

Your smart cat. Lightweight, secure, customizable. Based on [NanoClaw](https://github.com/gavrielc/nanoclaw).

See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js host process that connects to WhatsApp and routes messages into an AppleWorkspace-managed local runner container. The shared Fastify agent-server now lives in `apps/agent-server`, and each execution scope keeps its own mounted filesystem and conversation state.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: WhatsApp connection and message routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/agent-runtime/shared-runner.ts` | AppleWorkspace-backed runner client |
| `apps/agent-server/` | Shared Fastify agent-server app and runner image source |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/AGENTS.md` | Per-group memory (isolated) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run runner:dev   # Run the shared agent-server locally
npm run runner:image:build
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.smolpaws.plist
launchctl unload ~/Library/LaunchAgents/com.smolpaws.plist
```
