# SmolPaws Context Files

This directory adapts the OpenClaw template family for SmolPaws.

SmolPaws should treat this directory as the canonical local source of self/context:

- identity
- soul
- user
- tool and machine layout
- long-term memory
- daily memory

## Conversation context

The shared relay-server host loads the public root markdown files in this directory by default,
excluding `README.md` and `HEARTBEAT.md`. It supplies the full file bodies as always-on SDK repository
skills and freezes them in a private snapshot for each conversation. They are reused on later turns
and server restarts; source edits take effect for conversations that have not captured a snapshot yet.

The default files include:

- `AGENTS.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `SOUL.md`
- `MEMORY.md` (public guidance; private memory is selected by scope configuration)
- `BOOT.md`
- `BOOTSTRAP.md`

`HEARTBEAT.md` is the heartbeat ingress checklist, not general conversation context. The context
configuration can replace these defaults and add files for individual scopes. See
[conversation context files](../context-files.md) for configuration and snapshot behavior.

## Private State

Durable memory (`MEMORY.md`) and daily memory files live under `~/.smolpaws/memory/`. They contain machine-specific facts, operational details, and personal context that should not be in a public repository. The public `MEMORY.md` here carries only usage guidance; it does not load or authorize reading a private file. The host's private `context.json` can select that file for a scope such as `whatsapp:main`, in which case its full content enters that conversation's snapshot. Daily logs are not loaded unless explicitly configured; the agent can read relevant logs on demand within its scope.

Heartbeat is now available as a local LaunchAgent-backed ingress. The canonical local commands are:

- `npm run heartbeat:local`
- `npm run heartbeat:launchagent:install`
- `npm run heartbeat:launchagent:remove`

The heartbeat runner reuses the normal local agent-server when it is already up. If the loopback agent-server is not running, the heartbeat launcher starts it first and then queues the heartbeat conversation on the canonical `/api/conversations` path.

By default, the LaunchAgent runs once a day at 07:30 local time (`StartCalendarInterval`). Heartbeat runs reuse one conversation per local day, then start a new conversation the next day.

## Why This Exists

The product host keeps SmolPaws identity and selected durable context available even when a conversation
works inside another repository. Automatic AgentProfile/project-skill discovery and upstream's separate
bounded memory-index loader remain deferred under `smolpaws-45n`; explicit product context does not
complete those ports.
