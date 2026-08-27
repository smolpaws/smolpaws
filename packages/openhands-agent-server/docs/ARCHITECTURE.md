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

Python `OpenHands/software-agent-sdk` / `openhands-agent-server` @
**`966340979be26c2162e9ab8805557b715e1f1a78`**.

Keep this package and `@smolpaws/openhands-agent` in lockstep against that same
pinned commit until we deliberately advance both together.

Local source reference:

```text
~/repos/agent-sdk/openhands-agent-server/openhands/agent_server/
```

Primary upstream modules for this package:

- `api.py`, `openapi.py`
- `conversation_router.py`, `event_router.py`
- `bash_router.py`, `file_router.py`, `git_router.py`
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
9. **Secrets are keychain-only.** Keep upstream-facing secret interfaces where
   practical, but do not port Fernet/cipher/plaintext implementation details. Raw
   secrets belong only in the SDK's keychain-backed `SecretStore` path.
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
