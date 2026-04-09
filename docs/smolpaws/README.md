# SmolPaws Context Files

This directory adapts the OpenClaw template family for SmolPaws.

SmolPaws should treat this directory as the canonical local source of self/context:

- identity
- soul
- user
- tool and machine layout
- long-term memory
- daily memory

## Live Today

All root markdown files in this directory are loaded into the live SmolPaws context on every run.

That includes:

- `AGENTS.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `SOUL.md`
- `MEMORY.md`
- `HEARTBEAT.md`
- `BOOT.md`
- `BOOTSTRAP.md`

Daily memory files and heartbeat state live under `~/.smolpaws/memory/`. They are private, not auto-injected, and SmolPaws is explicitly pointed at them when needed.

Heartbeat is now available as a local LaunchAgent-backed ingress. The canonical local commands are:

- `npm run heartbeat:local`
- `npm run heartbeat:launchagent:install`
- `npm run heartbeat:launchagent:remove`

The heartbeat runner reuses the normal local agent-server when it is already up. If the loopback agent-server is not running, the heartbeat launcher starts it first and then queues the heartbeat conversation on the canonical `/api/conversations` path.

By default, the LaunchAgent runs once per day at `12:00` local time. Each heartbeat run gets its own conversation id instead of reusing one conversation for the whole day.

## Why This Exists

SmolPaws now has two layers of context:

- repo-specific guidance and skills from the target workspace or repo clone
- persistent SmolPaws identity/context from the canonical local `smolpaws` repo

That keeps the cat consistent even when it is acting inside some other repository.
