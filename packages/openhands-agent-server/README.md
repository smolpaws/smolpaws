# @smolpaws/openhands-agent-server

Idiomatic TypeScript transpilation of the OpenHands Python `openhands-agent-server` REST/WebSocket layer.

The durable maintenance policy lives in [`TRANSPILE_RULES.md`](TRANSPILE_RULES.md). The current implementation architecture lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The shared drift/oracle machinery is documented in [`enyst/openhands-agent/docs/DRIFT_TOOLING.md`](https://github.com/enyst/openhands-agent/blob/main/docs/DRIFT_TOOLING.md).

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
- additive caller-supplied `event_id` support for idempotent event append (`EXT-SERVER-001`);
- additive wildcard file/git path aliases and body-named profile creation routes (`EXT-SERVER-002` through `004`).

The SDK and server transpiles advance together against bounded `OLD_PIN..NEW_PIN` upstream intervals. Compatibility work remains tests-first/red-green.

## Provenance and OpenAPI oracle

The server does not author a second upstream pin. It consumes the canonical manifest packaged with the vendored SDK:

```text
vendor/openhands-agent/transpile/upstream.json
```

The pinned Python server OpenAPI and its provenance metadata are committed at:

```text
transpile/python-openapi.json
transpile/python-openapi.meta.json
```

Package CI validates their repository, commit, and content hash, regenerates the TypeScript OpenAPI, and compares operation coverage against the Python oracle. Missing operations, permanent deviations, and additive extensions must be named in `transpile/openapi-policy.json`; stale exceptions fail CI.

## Validation

Run the package gate with:

```sh
npm run ci
```

Useful focused commands:

```sh
npm run test:upstream-provenance
npm run openapi
npm run test:openapi-parity
npm run smoke:local
npm run test:pack
```

The operation comparator is the first OpenAPI evidence layer. Normalized request/response schema comparison follows on top of the same generated oracle and policy model.

Credential-gated LLM examples are provider viability checks, not Python/TypeScript differential parity tests.

## Documentation

- [`TRANSPILE_RULES.md`](TRANSPILE_RULES.md) — durable compatibility policy and pin-advance procedure
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — current server architecture
- [`transpile/openapi-policy.json`](transpile/openapi-policy.json) — exact machine-validated operation differences
- [`../../src/coordinator/DESIGN.md`](../../src/coordinator/DESIGN.md) — SmolPaws-owned durable message-work design around the server

## Work tracking

Beads/issues track work. They do not define compatibility or transpilation scope.
