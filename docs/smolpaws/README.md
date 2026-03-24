# SmolPaws Context Files

This directory adapts the OpenClaw template family for SmolPaws.

These files are meant to shape how SmolPaws behaves, but not all of them are live in the runtime yet.

## Live Today

The canonical local SmolPaws repo now loads these files into the agent context on every run:

- `AGENTS.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`

The canonical SmolPaws soul still lives at `../../SOUL.md`, and the agent-server turns that into the first-turn identity prefix.

## Reference Only For Now

These files are present because they are part of the OpenClaw-style workspace model, but SmolPaws does not fully execute them yet:

- `SOUL.md` - mirror and companion to the canonical root soul
- `HEARTBEAT.md` - needs proactive heartbeat ingress before it becomes operational
- `BOOT.md` - needs a startup hook before it becomes operational
- `BOOTSTRAP.md` - useful for first-run rituals, but not auto-invoked today

Heartbeat follow-up is tracked in Beads as `smolpaws-cdb`.

## Why This Exists

SmolPaws now has two layers of context:

- repo-specific guidance and skills from the target workspace or repo clone
- persistent SmolPaws identity/context from the canonical local `smolpaws` repo

That keeps the cat consistent even when it is acting inside some other repository.
