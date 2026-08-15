# OpenHands Agent Server Transpilation Contract

This file defines the durable policy for maintaining `@smolpaws/openhands-agent-server` as a TypeScript transpilation of the Python `openhands-agent-server` package.

It is policy, not status. Release/history notes belong elsewhere. Beads/issues track work. Generated OpenAPI/drift reports and tests provide evidence.

## Source and boundary

Upstream: `OpenHands/software-agent-sdk/openhands-agent-server`

Current pinned commit:

```text
966340979be26c2162e9ab8805557b715e1f1a78
```

Advance this package and `@smolpaws/openhands-agent` against the same upstream commit in bounded `OLD_PIN..NEW_PIN` batches.

The server owns the REST/WebSocket boundary, request/response validation, OpenAPI, server metadata, leases, and pub/sub. SDK-owned concepts such as events, conversations, tools, settings primitives, workspaces, and secret storage come from `@smolpaws/openhands-agent`.

The durable message-work coordinator in `src/coordinator/` is SmolPaws product architecture, not part of the upstream transpilation. Do not move queue semantics into this package merely because the product needs them.

## Compatibility promise

Preserve the upstream REST/WebSocket contract and observable behavior unless an explicit policy below says otherwise. Use idiomatic strict TypeScript, Fastify, zod v4, tsup, and vitest rather than line-by-line Python.

Target-language implementation differences are not deviations when the observable contract is preserved.

## Change dispositions

Use the same update vocabulary as the SDK transpilation:

- `PORT` — target tests/code must change to preserve compatibility;
- `NO_TARGET_CHANGE` — reviewed, no target change required; record why;
- `DEVIATION` — relevant area intentionally behaves differently; reference a `DEV-*` ID;
- `EXCLUDED` — upstream subsystem outside declared transpilation scope; reference an `EXC-*` ID;
- `DEFERRED` — in scope but intentionally postponed; record compatibility consequence and tracking item.

Extensions are target policy, not upstream-change dispositions. Give additive target-only behavior a stable `EXT-*` ID.

## Intentional policies

### DEV-SERVER-001 — no ACP runtime/model switching

Do not implement ACP runtime/model switching as active server behavior.

### DEV-SERVER-002 — no security analyzers or confirmation gates

Do not implement security analyzer/risk scoring, confirmation mode/policies/gates, or confirmation replies as active behavior. If compatibility routes exist, return an explicit unsupported/deviation response rather than a fake no-op.

### DEV-SERVER-003 — keyring-backed secret model

Do not port Fernet/cipher/plaintext secret-storage implementation details. Use the SDK `SecretStore` model. Raw secrets must not be persisted in metadata, events, OpenAPI fixtures, logs, or snapshots.

### DEV-SERVER-004 — profile-first product LLM configuration

Prefer profile-oriented settings and secret references. Raw LLM/API-key fields may exist only where compatibility genuinely requires them, and must not become the normal product path.

### DEV-SERVER-005 — no deferred-init flow

Do not implement upstream deferred-init behavior as active product behavior.

### EXT-SERVER-001 — caller-supplied idempotent `event_id`

`POST /api/conversations/{conversation_id}/events` may accept an optional caller-supplied `event_id` for durable idempotent append. Omitting it must preserve upstream behavior. This extension exists to close the coordinator append-response-loss window; it must not grow queue, ordering, retry, or delivery-state semantics inside agent-server.

## Tests-first rule

For compatibility work:

1. identify the upstream source change and relevant upstream tests/examples;
2. port/adapt the test first;
3. demonstrate red for the expected reason;
4. implement until green;
5. run package and cross-boundary regression suites.

Prefer real or close-to-live server tests for WebSockets, multipart I/O, git repositories, bash process behavior, persistence/restart, auth, leases, and concurrency.

## OpenAPI rule

OpenAPI is a parity oracle, not documentation garnish.

- Generate the Python OpenAPI/schema from the pinned upstream source.
- Generate the TypeScript OpenAPI from this package.
- Compare routes, methods, request schemas, response schemas, and status codes with explicit `DEV-*` / `EXT-*` allowlists.
- Do not maintain the upstream route inventory by hand when it can be generated.
- Generated artifacts must be deterministic across hosts and Node versions; runtime/environment metadata must not leak into schema defaults.

The existing hand-written route snapshot is transitional evidence and should be replaced by the generated Python oracle.

## Pin-advance procedure

Every update is a finite `OLD_PIN..NEW_PIN` interval.

1. Generate the upstream change inventory: commits/PRs, changed server source, tests/examples, and Python OpenAPI delta.
2. Classify meaningful changes before coding.
3. Port `PORT` work red/green.
4. Run OpenAPI differential, deterministic server tests, SDK/server integration, typecheck, lint, build, pack/smoke checks.
5. Do not move the pin while an in-scope change remains unclassified.

Credential-gated live LLM workflows prove external provider viability; they are not substitutes for Python/TypeScript parity tests.

## Validation

```sh
npm run ci
```

The package CI should include generated OpenAPI/parity checks, deterministic tests, local server smoke, typechecks, lint, build, and packed-consumer verification.

## Documentation ownership

- `TRANSPILE_RULES.md`: durable transpilation policy.
- `docs/ARCHITECTURE.md`: current implementation architecture.
- `README.md`: package usage and concise compatibility statement.
- `src/coordinator/DESIGN.md`: SmolPaws-owned coordinator invariants and rollout, not server parity policy.
- Beads/issues: work tracking only.

Code/tests describe current factual behavior; this contract describes intended policy. A mismatch between them must be investigated rather than silently normalizing one to the other.
