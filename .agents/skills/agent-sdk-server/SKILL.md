---
name: agent-sdk-server
description: Current upstream-shaped TypeScript OpenHands agent-server package and its boundary with the SmolPaws coordinator.
metadata:
  tags: openhands-agent-server, fastify, openapi, transpilation, coordinator
  source: packages/openhands-agent-server
---

# OpenHands Agent Server (TypeScript)

Use this skill when changing `packages/openhands-agent-server`, integrating with its REST/WebSocket API, or reasoning about server parity.

## Authoritative sources

- [`packages/openhands-agent-server/TRANSPILE_RULES.md`](../../../packages/openhands-agent-server/TRANSPILE_RULES.md) — compatibility policy and named deviations/extensions.
- [`packages/openhands-agent-server/docs/ARCHITECTURE.md`](../../../packages/openhands-agent-server/docs/ARCHITECTURE.md) — current server implementation.
- [`packages/openhands-agent-server/openapi.json`](../../../packages/openhands-agent-server/openapi.json) — generated TypeScript API contract.
- [`src/coordinator/DESIGN.md`](../../../src/coordinator/DESIGN.md) — SmolPaws-owned durable external-message work around the server.
- [`enyst/openhands-agent/docs/DRIFT_TOOLING.md`](https://github.com/enyst/openhands-agent/blob/main/docs/DRIFT_TOOLING.md) — shared pin and generated Python OpenAPI-oracle design.

## Boundary rules

- The package ports the Python agent-server REST/WebSocket contract using Fastify and the TypeScript SDK.
- SDK events, conversations, tools, workspaces, settings primitives, and secret storage are imported, not reimplemented.
- Durable external deduplication, lane ordering, claims, retries, delivery outcomes, and reconciliation belong to `src/coordinator/`, not agent-server.
- `EXT-SERVER-001` permits optional caller-supplied `event_id` for idempotent append; omitting it preserves upstream behavior.
- Do not reintroduce `/turns`, confirmation gates, security analyzers, ACP execution, or raw secret persistence as accidental compatibility work.

`apps/agent-server` is a separate legacy/product runner retained during migration. Do not use its routes or models as the transpilation oracle unless work explicitly targets that runner.

## Validation

```sh
npm run ci --prefix packages/openhands-agent-server
```

Credential-gated LLM examples prove provider viability, not Python/TypeScript parity.

## Reference

- [references/agent-sdk-server-api.md](references/agent-sdk-server-api.md) — how to find and validate the current API without copying a stale route list.
