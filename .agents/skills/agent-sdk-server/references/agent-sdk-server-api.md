# OpenHands agent-server API reference

Do not maintain a second hand-written endpoint catalog in this agent skill.

## Authoritative contract

- Generated TypeScript OpenAPI: [`packages/openhands-agent-server/openapi.json`](../../../../packages/openhands-agent-server/openapi.json)
- Route/schema source: [`packages/openhands-agent-server/src/openapi.ts`](../../../../packages/openhands-agent-server/src/openapi.ts)
- Transpilation policy: [`packages/openhands-agent-server/TRANSPILE_RULES.md`](../../../../packages/openhands-agent-server/TRANSPILE_RULES.md)
- Current architecture: [`packages/openhands-agent-server/docs/ARCHITECTURE.md`](../../../../packages/openhands-agent-server/docs/ARCHITECTURE.md)

The current route-parity script still contains a transitional hand-copied upstream inventory. The drift-tooling plan replaces it with OpenAPI generated from the pinned Python source plus a small explicit policy/extension allowlist.

## Stable interaction shape

The upstream-shaped conversation path is:

1. create or resolve a conversation;
2. append user input through the conversation `/events` surface;
3. request execution through `/run` when needed;
4. read/search durable events or subscribe through the event WebSocket.

`EXT-SERVER-001` adds an optional caller-supplied `event_id` to event append for idempotency. Callers that omit it receive upstream-compatible behavior.

The durable SmolPaws coordinator may orchestrate this flow, but queue claims, retries, ordering, delivery state, and platform reconciliation are not server API semantics.

## Before writing a client

Inspect `openapi.json` at the exact revision being used. Do not copy request fields from the old `apps/agent-server` runner, retired `/turns` flows, confirmation endpoints, or raw nested LLM/API-key examples.

## Validation

```sh
npm run openapi --prefix packages/openhands-agent-server
npm run test:route-parity --prefix packages/openhands-agent-server
npm run smoke:local --prefix packages/openhands-agent-server
```
