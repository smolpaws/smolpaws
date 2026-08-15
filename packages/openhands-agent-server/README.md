# @smolpaws/openhands-agent-server

Idiomatic TypeScript transpilation of the OpenHands Python `openhands-agent-server` REST/WebSocket layer.

The durable maintenance policy lives in [`TRANSPILE_RULES.md`](TRANSPILE_RULES.md). The current implementation architecture lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Boundary

This package owns the server protocol surface around `@smolpaws/openhands-agent`: Fastify routes, request/response validation, WebSockets, pub/sub, OpenAPI, server metadata, and lease/coordination concerns that belong to the server itself.

SDK concepts such as events, conversations, tools, workspaces, settings primitives, and secret storage come from `@smolpaws/openhands-agent` rather than being reimplemented here.

The durable message-work coordinator in `src/coordinator/` is **not** part of this transpilation. It is SmolPaws-owned product architecture around the upstream-shaped server and owns external deduplication, lane mapping, retries, delivery state, and reconciliation.

## Compatibility

The package preserves the upstream REST/WebSocket contract and behavior using idiomatic TypeScript. Intentional policy differences and additive extensions are explicitly named in `TRANSPILE_RULES.md`.

Notable current policies include:

- no ACP runtime/model switching;
- no security analyzer/risk-scoring or confirmation-gate execution;
- keyring-backed secret references instead of Python's cipher/storage split;
- profile-first product LLM configuration;
- no deferred-init flow;
- additive caller-supplied `event_id` support for idempotent event append (`EXT-SERVER-001`), while omitted `event_id` preserves upstream behavior.

The SDK and server transpiles advance together against bounded `OLD_PIN..NEW_PIN` upstream intervals. Compatibility work remains tests-first/red-green.

## Validation

Run the package gate with:

```sh
npm run ci
```

Useful focused commands:

```sh
npm run openapi
npm run test:route-parity
npm run smoke:local
npm run test:pack
```

The OpenAPI parity mechanism is being treated as an executable compatibility oracle. The durable rule is to generate the upstream OpenAPI/schema from the pinned Python source and compare it to the TypeScript output with explicit policy allowlists, rather than relying on a hand-maintained route inventory.

Credential-gated LLM examples are provider viability checks, not Python/TypeScript differential parity tests.

## Documentation

- [`TRANSPILE_RULES.md`](TRANSPILE_RULES.md) — durable compatibility policy and pin-advance procedure
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current server architecture
- [`../../src/coordinator/DESIGN.md`](../../src/coordinator/DESIGN.md) — SmolPaws-owned durable message-work design around the server

## Work tracking

Beads/issues track work. They do not define compatibility or transpilation scope.
