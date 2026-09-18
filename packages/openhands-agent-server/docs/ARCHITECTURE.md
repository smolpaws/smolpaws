# OpenHands Agent Server Transpile Architecture

`@smolpaws/openhands-agent-server` is the TypeScript server-layer sibling to
`@smolpaws/openhands-agent`. The SDK package owns the agent, conversation state,
event models, durable event log, file stores, tools, LLM adapters, and remote
client APIs. This package owns the OpenHands agent-server REST/WebSocket boundary:
Fastify routes, request/response validation, PubSub fanout, OpenAPI generation,
and thin service adapters over the SDK.

This document records the rules used for the first buildable server slice, what
was fulfilled, and what should remain true when the port continues.

## Pinned upstream target

Python `OpenHands/software-agent-sdk` / `openhands-agent-server`; the canonical
shared pin is `vendor/openhands-agent/transpile/upstream.json#commit`.

Keep this package and `@smolpaws/openhands-agent` in lockstep against that same
pinned commit until we deliberately advance both together.

Local source reference:

```text
~/repos/agent-sdk/openhands-agent-server/openhands/agent_server/
```

Primary upstream modules for this package:

- `api.py`, `openapi.py`
- `conversation_router.py`, `event_router.py`
- `bash_router.py`, `file_router.py`, `git_router.py`, `llm_router.py`
- `conversation_service.py`, `event_service.py`
- `pub_sub.py`, `sockets.py`, `conversation_lease.py`

## Transpilation rules fulfilled in this slice

1. **Server layer only.** This package ports the agent-server surface, not a second
   SDK. Agent execution, conversation state, event schemas, and event durability
   come from `@smolpaws/openhands-agent`.
2. **Idiomatic TypeScript, not line-by-line Python.** Fastify replaces FastAPI;
   zod schemas replace pydantic models; service classes are small adapters over
   SDK objects; route code is grouped by protocol area.
3. **Tooling parity with the SDK transpile.** The package uses strict TypeScript,
   ESM, tsup, vitest, type-checked eslint, zod v4, and OpenAPI generation.
4. **Upstream REST/WebSocket contract over SmolPaws turns.** The implemented public
   surface is the upstream `/events` + `/run` style API. `/turns` is intentionally
   absent and must not be reintroduced here.
5. **Events are SDK-owned durability.** The server does not own an event JSONL log.
   `EventService` wraps an SDK `EventLog` and `ConversationState`; appends go
   through `ConversationState.appendEvent()`, and reads/search/count use the
   EventLog-backed state.
   Uncaught run/factory exceptions are converted to an SDK `ConversationErrorEvent` unless the
   current invocation already appended one. New durable events are published before the final state
   update. Exception messages are redacted; arbitrary exception objects are never serialized.
   A later user prompt can run the same saved conversation again. See the
   [upstream port correction](../transpile/conversation-errors.md).
6. **Server metadata may remain server-owned.** Conversation `meta.json` is stored
   by this package because upstream keeps server-side conversation metadata too.
   Metadata is not the event source of truth.
7. **OpenAPI is a deliverable.** `generateOpenApiSchema()` and
   `scripts/generate-openapi.ts` are part of parity. New routes should update
   `src/openapi.ts` and the OpenAPI path assertions.
8. **Accepted deviations stay explicit.** Confirmation policy, confirmation
   responses, security analyzers, ACP runtime/model switching, and deferred init
   are not wanted as active features. If compatibility routes exist, they should
   return accepted-deviation/unsupported responses rather than fake no-ops.
9. **Secret storage is SDK-owned.** General secrets use the keychain-backed
   `SecretStore`; ChatGPT subscription OAuth uses the explicitly ported SDK
   credential store in `~/.openhands/auth`. Never persist credentials in server
   metadata, profiles or events, and never read Codex CLI credentials.
10. **LLM config is profile-first.** Required settings/profile work should prefer
   LLM profiles and secret references. Avoid raw LLM objects/API keys in server
   surfaces except where compatibility genuinely requires it.
11. **Tests prove protocol behavior.** Vitest coverage currently checks route
    basics, auth, OpenAPI shape, SDK agent execution, and restart restoration from
    the SDK `EventLog`.

## Current package map

| Area | Source | Responsibility |
|------|--------|----------------|
| App bootstrap | `src/app.ts` | Creates Fastify app, registers multipart/websocket/auth/routes, exposes server details and OpenAPI. |
| Models | `src/models.ts` | zod-backed REST request/response/event model compatibility. |
| Conversations | `src/conversationRouter.ts`, `src/conversationService.ts` | Start/search/count/get/update/delete/fork conversations, plus run/pause/interrupt helpers. |
| Events | `src/eventRouter.ts`, `src/eventService.ts` | Thin wrapper over SDK `EventLog` + `ConversationState`, plus PubSub publication. |
| Metadata + leases | `src/conversationMetadata.ts`, `src/conversationLease.ts` | Server-owned `meta.json` load/save/delete guarded by per-conversation lease ownership. No event log ownership. |
| PubSub/sockets | `src/pubSub.ts`, `src/sockets.ts` | In-process fanout for conversation events and bash events. |
| Bash | `src/bashRouter.ts`, `src/bashService.ts` | Upstream-shaped bash command/event routes and bash event websocket support. |
| Git | `src/gitRouter.ts`, `src/gitService.ts` | Upstream-shaped changes/diff routes. |
| File | `src/fileRouter.ts` | Upstream-shaped home/search/download/upload routes with multipart support. |
| Settings/profiles/skills | `src/serverState.ts`, `src/settingsRouter.ts`, `src/profilesRouter.ts`, `src/agentProfilesRouter.ts`, `src/skillsRouter.ts` | Profile-first settings, profile CRUD/activation/materialization, and local skills APIs. |
| LLM discovery/subscription | `src/llmRouter.ts`, SDK subscription auth | Curated model discovery and opaque device-login lifecycle; SDK owns credentials, refresh and provider requests. |
| Secrets | `src/conversationSecrets.ts`, SDK `SecretStore` | Keychain-backed app/conversation secret references without plaintext metadata or event persistence. |
| OpenAPI | `src/openapi.ts`, `scripts/generate-openapi.ts` | zod-to-JSON-Schema route table and generated schema CLI. |

## Request and event flow

```text
POST /api/conversations
  ↓
ConversationService creates StoredConversation + metadata
  ↓
EventService creates SDK EventLog(LocalFileStore(root), "<id>/events")
  ↓
ConversationState({ eventLog }) restores durable events
  ↓
POST /events or /run appends through ConversationState
  ↓
SDK EventLog writes event-00000-<event_id>.json files
  ↓
EventService publishes new events through PubSub/WebSocket
  ↓
/events/search and /events/count read the EventLog-backed state
```

The restart invariant is: dropping the in-memory services and recreating them from
the same `persistence_dir` restores events through the SDK EventLog. The server
must not need a parallel `events.jsonl` or route-owned append file to recover.

Incoming user events may be persisted while a tool is running. The SDK provider
adapters keep completed call/result groups adjacent in the outgoing LLM request,
without changing durable arrival order. If an older build failed on this ordering
after the tool completed, deploy the corrected SDK and use the existing conversation's
`POST /api/conversations/{conversation_id}/run`. Do not append the accepted user input
again or remove its completed observation. This recovery requires every tool result
to be present. On server startup, after claiming exclusive conversation ownership,
`EventService.recoverInterruptedTools()` appends an internal tool-error result for every
action whose outcome was not saved before the restart. It never reruns the interrupted
command, rewrites previous events, or makes a provider request. SDK request serialization
places these results next to their calls, ahead of user retries already in the log.
Repeated restoration adds no duplicate results or usage. A subsequent prompt or explicit
run continues the saved conversation. See [DEV-SERVER-008](../TRANSPILE_RULES.md#dev-server-008--restore-interrupted-calls-without-automatic-tool-replay)
and the [upstream correction](../transpile/interrupted-tools.md).

## LLM usage and costs

`GET /api/conversations/{id}` returns full per-usage accounting in
`stats.usage_to_metrics`. Each group retains per-completion `records`, `token_usages`,
`costs`, and `response_latencies`, plus accumulated values. `metrics` is the SDK's
combined snapshot across those groups. Search and batch-get use the same projection.
Groups use the profile identity by default; each record retains the requested and
returned model, so a changed model cannot relabel earlier usage.

Provider counters are recorded before dispatching the response's tools. The SDK
persists one environment `ConversationStateUpdateEvent` with key `llm_usage` in the
existing EventLog. Restoring a conversation derives its metrics from those records;
reading, subscribing, or replaying a stored record does not add usage. A duplicate user
append with `run:false` does not call the provider. A requested run that makes another
provider completion records it, even when the provider reuses its response ID. The
server publishes the metadata events through
its existing event stream and includes full statistics in `full_state` snapshots.
Consumers must not treat accounting metadata as an assistant message or a delivery.

Missing values remain visible. `accumulated_token_usage` and `accumulated_cost`
are nullable when observations are missing; `known_token_usage`, `known_costs`, and
`coverage` describe what was measured. A provider's reported charge and a calculated
estimate retain different provenance. Currency is preserved, including provider
credits, and unknown cost is never presented as free usage. Historical conversations
without accounting records keep `coverage.unmeasured_history:true`; new usage can
accumulate without inventing a total for the earlier history.

Forking with the default `reset_metrics:true` copies the conversation and appends an
SDK `llm_metrics_reset` boundary. The fork starts fresh accounting after that boundary,
including after a restart. `reset_metrics:false` retains the copied accounting. Both
forks remain independent from the source. These behaviors and the intentional wire
differences from Python are described by `DEV-SERVER-007` in `TRANSPILE_RULES.md` and
covered by `src/__tests__/metrics.test.ts`.

Anthropic prompt caching is owned by the vendored SDK, including OpenAI-compatible
Anthropic proxy profiles. The default profile factory passes the snapshotted profile
and configured context through that SDK path; it must not add a separate server cache
implementation. Supported models enable explicit cache breakpoints by default, even
when an older stored profile has no `cachingPrompt` field. Set `cachingPrompt:false` in
a profile to opt out. The optional `anthropicCacheTtl` selects `"5m"` or `"1h"`.
An omitted field stays absent from parsed profiles, REST output, persisted state and
conversation snapshots; it has no schema default. For Anthropic models, including
compatible proxies, cache serialization interprets omission as the provider's
five-minute behavior. Other providers do not acquire an Anthropic setting.
The SDK emits `ttl:"1h"` on Anthropic cache controls for the
one-hour selection, including Anthropic models behind an OpenAI-compatible proxy.
The five-minute selection preserves the existing wire format without an explicit TTL.
This setting is separate from OpenAI's `promptCacheRetention`.

Profile CRUD, validation, generated OpenAPI, persistence, and conversation snapshots
use the SDK profile schema. The server does not translate or independently default the
TTL. Updating a catalog entry changes future bindings; existing conversations retain
their saved TTL after restart. Explicitly reselecting that profile with `switch_llm`
loads the updated record at the normal complete-step boundary. `cachingPrompt:false`
still suppresses automatic cache markers regardless of the selected duration.

Cache reads and writes remain provider-reported measurements; selecting a duration or
sending a breakpoint alone does not establish a cache hit. The
[SDK port correction](https://github.com/smolpaws/openhands-agent/blob/main/transpile/anthropic-cache.md)
documents the upstream behavior and provider-specific serialization. The server
regression `src/__tests__/promptCaching.test.ts` exercises TTL validation and CRUD, generated
OpenAPI, full configured context, outgoing requests, cache accounting, and preservation
of a saved TTL or its absence across catalog edits and conversation restore. It also
checks that non-Anthropic profiles and conversations keep the field absent. It keeps
the normal Agent and profile factory; only the provider HTTP boundary is substituted.

## Implemented surface in the first buildable slices

Server details:

- `/`, `/alive`, `/health`, `/ready`, `/server_info`, `/openapi.json`

Conversation/event routes:

- `/api/conversations` search/count/batch/start
- `/api/conversations/{conversation_id}` get/update/delete
- `/api/conversations/{conversation_id}/events` post
- `/api/conversations/{conversation_id}/events/search`
- `/api/conversations/{conversation_id}/events/count`
- `/api/conversations/{conversation_id}/events/batch`
- `/api/conversations/{conversation_id}/events/{event_id}`
- `/api/conversations/{conversation_id}/run`
- `/api/conversations/{conversation_id}/pause`
- `/api/conversations/{conversation_id}/interrupt`
- `/api/conversations/{conversation_id}/fork`
- `/api/conversations/{conversation_id}/agent_final_response`
- `/sockets/events/{conversation_id}`

Bash/git/file routes:

- `/api/bash/bash_events`, `/api/bash/bash_events/{event_id}`,
  `/api/bash/bash_events/batch`, `/api/bash/start_bash_command`,
  `/api/bash/execute_bash_command`, `/api/bash/clear_bash_events`,
  `/sockets/bash-events`
- `/api/git/changes`, `/api/git/diff`
- `/api/file/home`, `/api/file/search_subdirs`, file download/upload surfaces

## Explicit non-goals for this package

- Do **not** port SmolPaws `/turns`.
- Do **not** implement ACP runtime/model switching.
- Do **not** implement confirmation mode, confirmation policy/gates, or
  confirmation replies.
- Do **not** implement security analyzer/risk scoring.
- Do **not** implement deferred init.
- Do **not** create a second event persistence format.
- Do **not** create an alternate secret storage model; use keychain-backed
  `SecretStore` only.
- Do **not** move SDK responsibilities into the server package.
- Do **not** chase upstream HEAD casually; advance the pinned commit deliberately.

## Required route families implemented in this slice

These route families are required for the replaceable SmolPaws server goal and are implemented with tests and OpenAPI coverage in this slice:

- skills routes/services
- settings routes/services with LLM-profile-first semantics
- profiles routes/services
- agent-profiles routes/services
- LLM profile-oriented routes needed by settings/profile flows
- conversation secret interfaces backed by the SDK keychain `SecretStore`
- per-conversation lease ownership safeguards for multi-instance/restart overlap

## Accepted deviations and useful-later deferrals

Accepted deviations / not wanted as active features:

- confirmation policy
- respond-to-confirmation
- security analyzer
- ACP runtime/model switching
- deferred init

Useful later, but not immediate blockers for the first replaceable slice:

- file trajectory download
- OpenAI-compatible `/v1/*` gateway
- VS Code and desktop routes
- auth cookie routes
- MCP test route
- workspace routers

Use explicit accepted-deviation or unsupported responses where compatibility routes
exist. The goal is clarity for clients and future agents.

## Validation criteria before opening or updating a PR

Run from `packages/openhands-agent-server`:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run openapi
npm run test:route-parity
npm run test:pack
```

From the repository root, regenerate all current OpenAPI artifacts with:

```sh
scripts/generate-openapi.sh
```

Useful regression expectations:

- OpenAPI includes `/events`, `/events/search`, `/run`, `/pause`, `/interrupt`,
  bash/git/file routes, and accepted-deviation responses.
- OpenAPI does not include `/turns`.
- Restart test proves SDK EventLog restoration and verifies no `events.jsonl` is
  created by the server.
- Tests should use temporary persistence directories, not the default workspace.

## Parity hardening status

The replacement-relevant hardening cases are covered without broadening the accepted route scope:

- Real temporary repositories cover changes, diff, untracked files, deleted/renamed files,
  explicit refs, unborn `HEAD`, non-repositories, and filesystem aliases.
- File tests cover multipart and raw uploads, downloads, root authorization, escaping and
  inside-pointing symlinks, special filenames, pagination, and validation failures.
- Live WebSocket tests cover conversation `resend_mode=all`, `since` timestamp boundaries,
  deprecated `resend_all` precedence, bash replay/fanout, auth, and reconnect accounting.
- Bash tests cover process-group timeout cleanup and traps, retention cleanup, bounded
  five-megabyte output coalescing, and stalled-subscriber isolation.
- The generated OpenAPI gate accounts for all 104 operations in the pinned Python source:
  73 implemented and 31 accepted deferrals, plus 6 intentional TypeScript extensions.

Pinned mock-only logging assertions and platform-specific `psutil` RSS/FD budgets are not
ported one-for-one. Deterministic behavioral tests cover the replacement-relevant invariants
instead. Provider-backed workflows remain manual because they require credentials.

The remaining work is operational confidence: keep supported provider profiles live-tested,
write the cutover/rollback runbook, and advance the upstream pin deliberately. The separate
upstream-compatible delivery queue replaces `/turns`; it is not package parity work and does
not block this package.


### Product tool composition

`createAgentServerApp({ configureTools })` lets a host bind product tool executors after normal profile
resolution. The default is unchanged. SmolPaws' relay-server host uses this seam for its shared scheduler
and file outbox; the parity package owns no channel queue or scheduling database.

### Product context composition

`createAgentServerApp({ configureContext })` lets the host compose SDK context after the existing
launch-addition suffix is resolved. The callback receives that context and the stored conversation;
omitting it retains the bare server behavior. It adds no HTTP fields or changes to the 32,768-character
launch-addition limit. The server factory tests cover asynchronous composition, preserved context and
the unchanged default path.

SmolPaws' `apps/relay-server/src/context.ts` uses this callback to load configured files as always-on,
non-AgentSkills `Skill` objects. It selects scope through the registered scheduler lane, not request
tags, and atomically writes a private `smolpaws-context.json` alongside `meta.json` and `events/` on first
use. Subsequent runs restore the same validated file bodies before looking at configuration or source
files. Existing conversations without a snapshot capture one on their next run through this host;
later configuration changes apply only where no snapshot exists yet. Corrupt snapshots and explicit
missing configuration/files fail instead of replacing context silently.

The fork API copies request/event history, not the product context snapshot. A fork's new direct
agent-server lane receives a fresh configured snapshot on first use, without inheriting the source
lane's private context selection.

The snapshot and configuration belong to the product host, not to this parity package or the SDK.
See [conversation context files](../../../docs/context-files.md) for version-1 configuration, scoped
private files and update semantics. Native upstream memory loading (`load_memory`, default 6,000
characters across user/project indexes), its preference propagation, and full AgentProfile skill
discovery remain deferred under `smolpaws-45n`; this product feature does not claim those semantics.

## Native profile selection during a conversation

`profileRuntime.ts` owns durable pending profile choices and active snapshot updates. The profile
factory binds the SDK's `switch_llm` tool when `enable_switch_llm_tool` is enabled (the default), or
when the tool is explicitly requested. It advertises saved profile names and delegates validation to
the shared profile store/client factory. The tool queues a fully validated snapshot before returning;
the SDK's `onStepBoundary` callback activates it only outside a model/tool batch, even when the same
response also calls `finish`. Replacement agents retain the existing tools and context objects.

Hosts may provide `createAgentServerApp({ resolveProfileSelection })` with an
`AgentFactoryContext => string | undefined | Promise<string | undefined>` function. Selection is
observed when work is requested, never by polling or interrupting execution. Persisted
`llm_profile_selection.configured_ref` tracks the applicable configuration independently of tool
choices; `pending_profile` closes the accepted-tool/restart window. Changes to unrelated host config
or a saved profile under the same reference do not reset the effective binding. Removing a selection
preserves the current choice. Changing it to the active profile cancels an older pending choice.

`ConversationService.updateOwnedRequest` merges request updates under the ownership lease, saves
atomically, then publishes them in memory before releasing the guard. `EventService` preserves its
SDK conversation and uses `lastStepUserMessageId` to resume an input that arrived during the final
completion. `whenIdle()` waits for execution, metadata saves and publication without closing event
subscriptions. On first/restored execution, the SDK anchors old-history origin before any replacement
snapshot is committed; the prepared replacement client enters the normal factory without requiring
the superseded profile's credentials. A boundary failure invalidates the cached conversation: if a
lease cleanup error followed a successful metadata commit, the next turn rebuilds the new binding;
if commit failed, it retries the saved pending choice. See `DEV-SERVER-009` and `profileSwitch.test.ts`.

## ChatGPT subscription profiles

`POST /api/llm/subscription/openai/device/start` returns the browser verification URL, user code
and an opaque polling token. Clients open that URL for user authorization, then post the token as
`{"device_code":"…"}` to `/api/llm/subscription/openai/device/poll`. Tokens are scoped to one server
process, expire after the upstream timeout, and are invalidated by logout. A pending or duplicate
in-flight poll returns `connected:false`; an unknown/expired token returns 404. A server restart
requires a new login challenge, but the SDK's connected credentials survive restart.

Create a profile with `authType:"subscription"`, `subscriptionVendor:"openai"`, `providerId:"openai"`
and a model from `/api/llm/subscription/openai/models`. No API key belongs in the profile. The same
SDK auth instance serves status, profile validation, new conversations and restored conversations.
Refresh occurs at the SDK request boundary; long-running conversations do not retain a stale bearer.
Normal session-key authentication protects every `/api/llm` route. HTTP responses expose no OAuth
access token, refresh token or provider device identifier.

For a real provider check with temporary server state, run `npm run manual:subscription` from the
package. It uses the connected SDK account, validates a profile, and completes two think/finish
turns. `OPENHANDS_SUBSCRIPTION_MODEL` selects a model explicitly. It does not touch a bridge or change
a running service or the user's active profile.

Validation on 2026-09-15 against the canonical packed SDK `775869e` completed profile preflight,
two real `gpt-5.5` think/finish turns and continuation using the existing SDK-owned OAuth account.
No bridge was connected and no active deployment profile changed. Deterministic tests separately
cover device login, expired/pending challenges, logout races, refresh, missing credentials and
persisted conversation restoration; the live check does not replace those parity tests.

## Standard condensation — 2026-09-18

The profile factory constructs the SDK summarizer from validated settings and a separately selected
profile. A private `condenser_binding` in the stored request freezes the profile and effective
settings, including an inherited token cap. Resolution happens outside the ownership lock; the
metadata update rechecks current state before saving. Public creation strips that binding. A later
main-profile switch retains the same condenser. Restarts and forks after capture retain its settings;
a fork before capture selects independently on first use. Host context snapshots and tools are not
replaced or truncated by condensation.

`EventService.condense()` shares its cached `LocalConversation` with ordinary runs. The SDK serializes
maintenance with individual steps, so it waits for a complete model/tool batch without waiting for
the entire run. The server tracks maintenance promises for idle/close, saves metadata and publishes
new durable events once even on failure. Manual requests preserve paused/finished state and do not
consume a queued user input. Automatic condensation remains entirely inside SDK steps.

`eventWire.ts` adapts the SDK Set of forgotten IDs to an array at REST and WebSocket boundaries.
EventLog continues to own disk serialization. Summary usage is the SDK's `condenser` usage group,
with the actual selected profile/model and explicit unknown provider counters. There is no second
server counter or summary algorithm. See [source and validation evidence](../transpile/condensation.md)
and the [product configuration and command guide](../../../docs/condensation.md).
