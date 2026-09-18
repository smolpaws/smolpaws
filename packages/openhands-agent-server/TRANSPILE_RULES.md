# OpenHands Agent Server Transpilation Contract

This file defines the durable policy for maintaining `@smolpaws/openhands-agent-server` as a TypeScript transpilation of the Python `openhands-agent-server` package.

It is policy, not status. Release/history notes belong elsewhere. Beads/issues track work. Generated OpenAPI/drift reports and tests provide evidence.

## Source and boundary

Upstream: `OpenHands/software-agent-sdk/openhands-agent-server`

The canonical upstream repository, full commit SHA, shared SDK/server scope, and policy IDs are read from the vendored SDK manifest:

```text
vendor/openhands-agent/transpile/upstream.json
```

Do not duplicate the literal upstream pin in this contract or parity scripts. Advance this package and `@smolpaws/openhands-agent` against the same upstream commit in bounded `OLD_PIN..NEW_PIN` batches.

The server owns the REST/WebSocket boundary, request/response validation, OpenAPI, server metadata, leases, and pub/sub. SDK-owned concepts such as events, conversations, tools, settings primitives, workspaces, and secret storage come from `@smolpaws/openhands-agent`.

The durable message-work coordinator in `src/coordinator/` is SmolPaws product architecture, not part of the upstream transpilation. Do not move queue semantics into this package merely because the product needs them.

## Compatibility promise

Preserve the upstream REST/WebSocket contract and observable behavior unless an explicit policy below says otherwise. Use idiomatic strict TypeScript, Fastify, zod v4, tsup, and vitest rather than line-by-line Python.

Target-language implementation differences are not deviations when the observable contract is preserved.

Uncaught conversation-run failures must persist and publish the SDK's `ConversationErrorEvent`,
including failures during agent construction. An error already emitted by that run must not be
duplicated. Preserve subsequent-prompt continuation and apply `DEV-SERVER-003` to exception details.
Channel notices and delivery deduplication belong to the coordinator. See the
[focused run-error port correction](transpile/conversation-errors.md) and its regression evidence.

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

Prefer profile-oriented settings and secret references. Raw LLM/API-key fields may exist only where compatibility genuinely requires them, and must not become the normal product path. Any new addition of raw fields requires human approval.

The SDK's profile-first Anthropic cache duration setting, `anthropicCacheTtl`, also flows
through server CRUD, validation, generated OpenAPI and saved conversation profiles.
The field is optional, with accepted values `5m` and `1h`; omitted fields stay absent
in API output, persisted profiles and conversation snapshots, including non-Anthropic
profiles. For Anthropic models, including compatible proxies, cache serialization
interprets omission as five-minute behavior.
Validation, provider serialization and accounting belong to the SDK. This is target
profile policy under `DEV-SDK-004`,
not a claim that the pinned Python server exposes an equivalent TTL field. Do not add
bridge-specific cache settings or a second server-side marker implementation. Preserve
snapshot semantics: a catalog edit alone cannot alter the TTL of a saved conversation;
explicit profile reselection uses `DEV-SERVER-009`. Evidence: `src/__tests__/promptCaching.test.ts`.

### DEV-SERVER-005 — no deferred-init flow

Do not implement upstream deferred-init behavior as active product behavior.

### EXT-SERVER-001 — caller-supplied idempotent `event_id`

`POST /api/conversations/{conversation_id}/events` may accept an optional caller-supplied `event_id` for durable idempotent append. Omitting it must preserve upstream behavior. This extension exists to close the coordinator append-response-loss window; it must not grow queue, ordering, retry, or delivery-state semantics inside agent-server.

### EXT-SERVER-002 — wildcard file-path aliases

In addition to the upstream query-parameter file routes, the server may expose additive wildcard-path aliases for file upload and download. The upstream operations remain available and authoritative for compatibility.

### EXT-SERVER-003 — wildcard git-path aliases

In addition to the upstream query-parameter git routes, the server may expose additive wildcard-path aliases for changes and diff. The aliases must call the same underlying behavior rather than fork the git contract.

### EXT-SERVER-004 — body-named profile creation aliases

The server may accept additive collection-level `POST /api/profiles` and `POST /api/agent-profiles` creation routes whose bodies carry the profile identity. The upstream path-named creation routes remain available.

### EXT-SERVER-005 — root server-details routes

The server exposes root-level server-details routes (`/`, `/alive`, `/health`, `/ready`, `/server_info`) that the upstream public OpenAPI contract no longer publishes after it narrowed the release contract to the `/api/` surface. They remain additive TS-server surface and are not part of the upstream `/api` parity comparison.

## Subscription authentication

The five `/api/llm/subscription/openai/*` routes port the pinned Python device-login contract.
The server retains opaque polling-token state, prevents concurrent polling of one challenge, drops
expired challenges, and fences in-flight results across logout. The SDK owns device requests,
credential persistence in `~/.openhands/auth`, refresh and subscription request transformation.
Never read the Codex CLI's `~/.codex/auth.json`. OAuth credentials are never written into profile
snapshots or server events. Profile validation and conversation execution use the same SDK factory
and subscription auth instance, so both restore/refresh the connected account.

This completes former `DEFER-SERVER-001` (beads `smolpaws-zlo.1` / `smolpaws-zlo.2`). The router's
`/llm` prefix is mounted under `/api`, as in Python. `DEV-SERVER-003` applies to profile/general
secret storage; it does not exclude the explicitly ported SDK OAuth credential store. The historical
`3896f1869363:server` review classified preflight credential restoration too broadly as a deviation:
that behavior is now ported and tested in `src/__tests__/subscriptionProfile.test.ts`.

### DEV-SERVER-006 — curated model discovery without LiteLLM

`GET /api/llm/models/verified` returns the exact pinned SDK `VERIFIED_MODELS` mapping.
`GET /api/llm/providers` and `GET /api/llm/models` use that curated mapping, preserving response
shapes, sorted unique model lists and provider filtering. Python's additional LiteLLM unverified
registry and optional AWS discovery are not provided: TS calls providers directly and does not
bundle LiteLLM. The list is discovery guidance, not an allowlist or a claim that every provider
configuration has been live-tested in TS. Profiles can still name models outside this catalog.

### DEV-SERVER-007 — provider accounting with explicit unknown values

`ConversationInfo.stats` projects the SDK's `ConversationStats`: per-usage metrics with
per-completion records and accumulated values. The SDK owns provider normalization,
cost provenance, accumulation, history coverage, and durable accounting. Its `DEV-SDK-007`
policy applies at this boundary: unreported counters and costs remain unknown, totals with
missing observations are nullable, and `known_token_usage`, `known_costs`, and `coverage`
describe the measured portion. Currency is preserved; non-USD credits are not silently
reported as a USD `accumulated_cost`. Calculated costs remain labeled estimates with their
pricing provenance.

The top-level `ConversationInfo.metrics` is the SDK's combined snapshot of those same
records. At the Python pin, `_compose_conversation_info` instead reads the optional stored
metadata snapshot, which native execution does not update. Populating the field from current
SDK statistics is an intentional TS correction; the server does not maintain a second counter.

The native EventLog stores one SDK `ConversationStateUpdateEvent` with key `llm_usage` per
recorded completion, rather than Python's separate `base_state.json` metrics history.
These environment metadata events are published through the existing event stream and are
not agent replies. `full_state` updates include the full statistics object, as upstream does.
Forks preserve their conversation events but append the SDK's durable `llm_metrics_reset`
boundary by default; `reset_metrics:false` retains the source accounting. Restart replays
the same records and reset boundary without charging them again. Histories created before
accounting was available remain explicitly incomplete until a reset boundary.

Evidence: `src/__tests__/metrics.test.ts`, adapted from pinned
`tests/sdk/conversation/local/test_fork.py` and the `ConversationStats` serialization contract,
exercises provider responses, idempotent append, event publication, restart, changed response
models, fork reset/preservation, missing usage, and older unmeasured history.

### Concurrent input and SDK request history

The SDK's `DEV-SDK-009` records which input a completion consumed, and projects messages received
during that completion after its response in subsequent model requests. Its durable
`llm_request_boundary` state updates use the existing event envelope; they are metadata, not agent
replies. The server preserves arrival order and idempotent append, and still schedules a follow-up
for an unseen user message. Do not suppress that follow-up or implement a second provider-history
projection here. Restart replays the SDK evidence; unannotated old history is not reconstructed.
`src/__tests__/concurrentMessages.test.ts` and `profileSwitch.test.ts` cover text/image arrivals,
tool-time input, deduplication, restore, and profile changes at the completed-step boundary.

### DEV-SERVER-008 — restore interrupted calls without automatic tool replay

After claiming exclusive ownership of a disk-restored conversation, the server appends an SDK
`AgentErrorEvent` for every action with no saved result, before exposing the conversation to
requests. Each result states that the outcome is unknown after a restart and uses the upstream
`internal`, non-retryable classification. Existing results, errors, user messages and accounting
remain intact. No interrupted command is automatically executed again, and recovery makes no
provider request. A later prompt or explicit run can continue the same conversation.

This ports upstream `EventService.start()` crash recovery with two deliberate differences:
Python checks persisted `RUNNING`, while TS does not persist execution status and therefore
uses unmatched actions in exclusively owned restored history; Python marks the first unmatched
action and may execute remaining pending actions, while TS closes every unknown-outcome action
in a parallel batch. Re-executing a command whose side effects may have completed before the
crash could duplicate work. The durable log remains append-only; SDK provider adapters order
completed tool results before any queued user retries in the outbound request. This policy does
not apply to live/new/forked conversations. If confirmation support is added, distinguish
awaiting approval from interrupted execution before extending this restoration rule.

Source, historical review correction and evidence: [restart recovery](transpile/interrupted-tools.md).

### DEV-SERVER-009 — profile-first conversation rebinding at quiescent step boundaries

Native `switch_llm` selects a saved `LLMProfile` through the SDK tool contract. The server validates
and constructs the replacement client, durably queues its secret-free profile snapshot, and returns
from the tool without waiting for its own run. Activation occurs only after the complete model/tool
step and all parallel results settle, including a step that also finishes the conversation. The
existing conversation state, history, workspace, context, tools, limits and accounting remain intact.
Configuration and activation errors stop the affected run; failed tool preparation returns an error
observation while retaining the working binding. Before-commit failures preserve the old
effective snapshot and any accepted pending choice. Cleanup can fail after committing a new snapshot;
the cached conversation is invalidated on boundary failure so the next turn reconstructs from that
durable binding instead of continuing with an old client. Neither recovery path repeats paid calls.

An optional TypeScript host hook, `resolveProfileSelection`, selects the applicable profile reference
when conversation work is requested. The server persists the last observed configured reference
separately from the effective choice: unchanged configuration cannot undo a tool selection, including
after restart. Same-reference profile edits retain the existing snapshot; explicit tool reselection
may refresh it. Removing a host selection leaves the effective/pending choice intact. Changing the
configured reference to the active one cancels a previously pending tool choice. Without the hook,
ordinary settings/profile edits retain existing conversation snapshots.

On first execution or restart, a configured replacement does not require credentials for the old
profile. The SDK anchors old-history provenance from the saved original profile before the server
commits the replacement snapshot and constructs the active agent. Provider replay/normalization and
usage accounting stay SDK-owned. Pending selections and snapshots remain server-owned fields stripped
from public creation requests. No HTTP switching route or ACP runtime is added; `DEV-SERVER-001` remains.

Evidence: `src/__tests__/profileSwitch.test.ts` covers configuration/tool selection, active-step races,
parallel tool completion, finish, failure, restart, bootstrap credentials, public fields and accounting.

## Condensation integration

The SDK owns View reconstruction, safe cuts, summarizing prompts, token/event/request triggers,
provider-error recovery and per-attempt accounting. The server materializes validated condenser
settings and delegates `POST /api/conversations/{conversation_id}/condense` to the cached SDK
conversation. Preserve upstream success and missing-conversation behavior; an unsupported condenser
is an error, never a successful no-op. Running work shares the SDK step guard. Manual maintenance
must be drained before closing subscriptions or releasing ownership, and completed durable events
must be published even when a later operation fails.

Under `DEV-SERVER-004` and SDK `DEV-SDK-004`, the summarizer uses an explicitly selected independent
profile. First use captures its secret-free profile and effective condenser settings with a guarded
metadata update before paid calls. Provider/client preparation stays outside the lease lock. Public
creation payloads cannot forge this internal binding. Main-profile changes retain it; restart and a
fork after capture retain it too. A fork before capture resolves independently in its trusted host
scope on first use. Disabled/no-op settings require no condenser profile or credentials. Missing
configuration for an enabled summarizer fails explicitly instead of borrowing the agent profile.

The server inherits SDK `DEV-SDK-011`: absent condenser event settings resolve to
`max_size: 1000`, `keep_first: 2`, consistently with the SDK class and helper. Preserve
explicit saved limits and captured bindings; do not restore Python's smaller defaults
at the HTTP/settings boundary. Token budgets remain separately configured.

The optional TypeScript host resolver selects the condenser role; channel scopes and command queues
stay outside this package. REST and both socket families serialize SDK forgotten-ID sets as JSON
arrays, as Python JSON-mode serialization does, without mutating the stored event or dropping unknown
accounting values. Source/evidence: [condensation port](transpile/condensation.md).

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
- Compare routes, methods, request schemas, response schemas, and status codes with explicit `DEV-*` / `EXT-*` policy entries.
- Do not maintain the upstream route inventory by hand when it can be generated.
- Generated artifacts must be deterministic across hosts and Node versions; runtime/environment metadata must not leak into schema defaults.

The canonical pinned Python artifacts are:

```text
transpile/python-openapi.json
transpile/python-openapi.meta.json
```

They are regenerated by `.github/workflows/refresh-python-openapi.yml`. Package CI verifies their source repository, pin, and content hash, then compares the generated TypeScript OpenAPI against them. Exact operation differences live in `transpile/openapi-policy.json`; temporary route debt references `transpile/deferred-operations.md`.

A trailing slash on a non-root OpenAPI path is treated as the same operation for inventory purposes. Other path aliases remain explicit extensions. The current comparator proves operation coverage and policy freshness; normalized request/response schema comparison is the next evidence layer.

## Pin-advance procedure

Every update is a finite `OLD_PIN..NEW_PIN` interval prepared and checked by the SDK drift tooling.

1. Generate the upstream change inventory: commits/PRs, changed server source, tests/examples, and Python OpenAPI delta.
2. Classify meaningful changes before coding.
3. Port `PORT` work red/green.
4. Vendor the SDK manifest for the selected interval and verify provenance.
5. Regenerate the pinned Python OpenAPI and reconcile stale/new operation policies.
6. Run OpenAPI differential, deterministic server tests, SDK/server integration, typecheck, lint, build, pack/smoke checks.
7. Do not move the pin while an in-scope change remains unclassified.

Credential-gated live LLM workflows prove external provider viability; they are not substitutes for Python/TypeScript parity tests.

The unattended weekly procedure that performs steps 1–7 is written out in [`docs/REVENDOR_AUTOMATION.md`](docs/REVENDOR_AUTOMATION.md).

## Server review records

The SDK repository generates the interval inventory for both targets, but its review files annotate `:server` units only as "transpiled separately". The server-side decisions live here:

```text
transpile/updates/<OLD8>..<NEW8>.json   machine-checked record
transpile/updates/<OLD8>..<NEW8>.md     human-readable record (subjects, reasoning, OpenAPI delta)
```

One pair per vendored interval, frozen once the interval's PR merges. The SDK marks every `:server` unit as `DELEGATED` in its own review and ships the interval inventory (`transpile/updates/<OLD8>..<NEW8>.inventory.json`) inside the package we vendor. The `.json` record here must contain exactly one item per server unit of that inventory (`<sha>:server`), each with a disposition (`PORT`, `NO_TARGET_CHANGE`, `DEVIATION`, `EXCLUDED`, `DEFERRED`), the policy ID where required (`DEV-SERVER-*` for `DEVIATION`, an `EXCLUDED` policy for `EXCLUDED`, none otherwise), a concrete reason, a tracking item for every `DEFERRED`, and existing TypeScript test paths as evidence for every `PORT`. It also carries the inventory's SHA-256 so a record cannot silently outlive the inventory it reviewed. The `.md` file adds subjects, reasoning, the pinned Python OpenAPI delta, and any `transpile/openapi-policy.json` changes.

`npm run test:server-review` (part of `npm run ci`) walks the vendored inventories from `transpile/server-reviews.json#since` to the vendored pin and fails on a missing, stale, or incomplete record, so a re-vendor cannot land without its review.

These records are review evidence, not a parity ledger. Compatibility is still proven by tests and the generated OpenAPI comparison.

## Validation

```sh
npm run ci
```

The package CI begins by validating the vendored canonical manifest, ensuring duplicate pin metadata has not crept back into the vendored package, and checking that every vendored interval has a complete server review record. It then runs generated OpenAPI parity, deterministic tests, local server smoke, typechecks, lint, build, and packed-consumer verification.

Focused checks:

```sh
npm run test:upstream-provenance
npm run test:server-review
npm run openapi
npm run test:openapi-parity
```

## Documentation ownership

- `TRANSPILE_RULES.md`: durable transpilation policy.
- `docs/ARCHITECTURE.md`: current implementation architecture.
- `README.md`: package usage and concise compatibility statement.
- `transpile/openapi-policy.json`: exact, machine-validated OpenAPI differences only.
- `transpile/deferred-operations.md`: tracking item for temporary operation debt.
- `src/coordinator/DESIGN.md`: SmolPaws-owned coordinator invariants and rollout, not server parity policy.
- `enyst/openhands-agent/docs/DRIFT_TOOLING.md`: shared manifest, interval-review, and differential-oracle machinery.
- Beads/issues: work tracking only.

Code/tests describe current factual behavior; this contract describes intended policy. A mismatch between them must be investigated rather than silently normalizing one to the other.

## Product tool composition

`createAgentServerApp({ configureTools })` may bind or extend profile-resolved SDK tools at the host boundary.
The default factory retains its behavior when omitted. This TypeScript factory option has no HTTP/schema
fields; scheduling, attachment spooling and bridge delivery remain in the consuming SmolPaws host,
`apps/relay-server`, using SDK EXT-SDK-001/002. It does not add product state to the transpiled package.

## Product context composition

`createAgentServerApp({ configureContext })` may compose an SDK `AgentContext` at the same host boundary.
It receives the existing context and stored conversation, runs after launch-addition suffix resolution,
and leaves the default factory unchanged when omitted. This is an internal TypeScript factory option,
not a new HTTP field. The upstream launch-addition limit remains 32,768 characters.

The SmolPaws host selects context files and the trusted scheduler scope, persists its own immutable
`smolpaws-context.json` beside conversation metadata, and supplies full contents as non-AgentSkills
`Skill` values with `trigger: null`. The SDK's existing `REPO_CONTEXT` rendering owns prompt inclusion.
The generic server must not select SmolPaws paths, infer private-file access from request tags, or
silently replace an established host snapshot. See the [product context contract](../../docs/context-files.md).
This composition uses an existing SDK surface; it does not lift the launch limit or establish a new
SDK memory implementation.

Upstream opt-in `load_memory` / `memory_context`, its 6,000-character user/project index loader and
server preference propagation (PRs #4178 and #4566) remain **DEFERRED**, tracked by `smolpaws-45n`.
Full AgentProfile context/skill discovery is also outstanding under that bead. The current compatibility
consequence is that upstream memory preferences and discovery do not produce the equivalent automatic
context here. Revisit when completing that bead or reviewing changes to these upstream surfaces; preserve
the pinned initialization, serialization and restore tests before claiming parity. The SDK's
[current correction](https://github.com/smolpaws/openhands-agent/blob/main/transpile/context-memory.md) supersedes earlier absence-based
`NO_TARGET_CHANGE` reasoning without rewriting frozen interval reviews. Host-owned context files do not
close this deferred work, and no memory exclusion is implied.
