# Docs

Current docs:

- [`smolpaws/SOUL.md`](smolpaws/SOUL.md) - canonical SmolPaws personality, voice, and behavioral design
- [`smolpaws/README.md`](smolpaws/README.md) - OpenClaw-style SmolPaws context-file set and which pieces are live today
- [`context-files.md`](context-files.md) - server-owned identity and memory files, scope configuration, and immutable conversation snapshots
- [`models.md`](models.md) - shared role and channel profile selections, safe runtime switching, and `switch_llm`
- [`condensation.md`](condensation.md) - standard condensation, separate profiles, manual commands and rollout prerequisites
- [`scheduled-agents.md`](scheduled-agents.md) - small scheduled helpers with explicit context, profiles and tools; Chrome Slack checking and durable handoff
- [`SPEC.md`](SPEC.md) - current system shape and runtime model
- [`REQUIREMENTS.md`](REQUIREMENTS.md) - architecture decisions and constraints
- [`SECURITY.md`](SECURITY.md) - security model
- [`agent-server-testing.md`](agent-server-testing.md) - agent-server runtime test harness, commands, and coverage boundaries
- [`agent-server-first-llm-request.md`](agent-server-first-llm-request.md) - human-readable first-request capture aligned with the runtime tests
- [`common-ingress-turn-client.md`](common-ingress-turn-client.md) - design for one shared ingress turn client with in-flight outbound delivery and additive final replies
- [`smolpaws/HEARTBEAT.md`](smolpaws/HEARTBEAT.md) - local LaunchAgent heartbeat checklist and state-file contract
- [`github/README.md`](github/README.md) - GitHub ingress and runner ops notes
- [`github/instructions.md`](github/instructions.md) - GitHub mention intake details
- [`github/deployment-alternatives.md`](github/deployment-alternatives.md) - GitHub/runner deployment options
- [`slack/README.md`](slack/README.md) - Slack app architecture and implementation plan
- [`slack/instructions.md`](slack/instructions.md) - Slack app setup and local run notes
- [`whatsapp/README.md`](whatsapp/README.md) - standalone WhatsApp Message Relay bridge: flow, device linking, launchd, six-point verification, rollback
- [`bridges.md`](bridges.md) - how standalone bridges start (LaunchAgent → bridge → agent-server), shared runtime, conversation defaults
