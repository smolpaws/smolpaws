---
name: customize
description: Modify SmolPaws behavior, bridge integrations and product configuration.
---

# Customize

Read [bridge conventions](../../../apps/AGENTS.md) and the target app's instructions first.

- Platform socket and policy: `apps/{whatsapp,slack,discord}/src/`.
- GitHub/email verification and Cloudflare queue: `apps/{github,email}/src/`.
- Durable intake, ordering, retry and delivery: `src/coordinator/`.
- Host context/tools, heartbeat and webhook intake: `apps/relay-server/src/`.
- Upstream-shaped REST/WebSocket API: `packages/openhands-agent-server/` (read `/agent-sdk-server`).
- Identity/memory selection: [context files](../../../docs/context-files.md).
- Model/profile selection: [models](../../../docs/models.md).

Add new socket bridges using the existing standalone pattern. Keep product extensions out of the
transpilation package. Do not restore the retired root router, `/turns`, or bridge loader.
Test affected real paths and typecheck before requesting any live restart or deployment.
