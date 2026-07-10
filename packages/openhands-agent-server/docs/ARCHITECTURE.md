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
   responses, and security analyzer endpoints are represented as accepted-deviation
   responses. Do not revive them as fake stubs.
9. **No plaintext secret persistence.** This package inherits the SDK's secret
   model: persistent settings should contain references, while raw secrets belong
   in the keyring-backed `SecretStore` path when that server surface is added.
10. **Tests prove protocol behavior.** Vitest coverage currently checks route
    basics, auth, OpenAPI shape, SDK agent execution, and restart restoration from
    the SDK `EventLog`.

## Current package map

| Area | Source | Responsibility |
|------|--------|----------------|
| App bootstrap | `src/app.ts` | Creates Fastify app, registers multipart/websocket/auth/routes, exposes server details and OpenAPI. |
| Models | `src/models.ts` | zod-backed REST request/response/event model compatibility. |
| Conversations | `src/conversationRouter.ts`, `src/conversationService.ts` | Start/search/count/get/update/delete/fork conversations, plus run/pause/interrupt helpers. |
| Events | `src/eventRouter.ts`, `src/eventService.ts` | Thin wrapper over SDK `EventLog` + `ConversationState`, plus PubSub publication. |
| Metadata | `src/conversationMetadata.ts` | Server-owned `meta.json` load/save/delete. No event log ownership. |
| PubSub/sockets | `src/pubSub.ts`, `src/sockets.ts` | In-process fanout for conversation events and bash events. |
| Bash | `src/bashRouter.ts`, `src/bashService.ts` | Upstream-shaped bash command/event routes and bash event websocket support. |
| Git | `src/gitRouter.ts`, `src/gitService.ts` | Upstream-shaped changes/diff routes. |
| File | `src/fileRouter.ts` | Upstream-shaped home/search/download/upload routes with multipart support. |
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
- Do **not** implement confirmation policy/gates.
- Do **not** implement security analyzer/risk scoring.
- Do **not** create a second event persistence format.
- Do **not** move SDK responsibilities into the server package.
- Do **not** chase upstream HEAD casually; advance the pinned commit deliberately.

## Accepted deviations from upstream Python

These surfaces may appear in the OpenAPI table so callers get a clear response,
but they are intentionally not implemented:

- confirmation policy
- respond-to-confirmation
- security analyzer
- ACP runtime/model switching
- ask-agent helpers
- condensation helpers
- full secrets/settings/profile runtime routes

Use explicit accepted-deviation responses for confirmation/security rather than
silent no-ops. The goal is clarity for clients and future agents.

## Validation criteria before opening or updating a PR

Run from `packages/openhands-agent-server`:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run openapi
```

Useful regression expectations:

- OpenAPI includes `/events`, `/events/search`, `/run`, `/pause`, `/interrupt`,
  bash/git/file routes, and accepted-deviation responses.
- OpenAPI does not include `/turns`.
- Restart test proves SDK EventLog restoration and verifies no `events.jsonl` is
  created by the server.
- Tests should use temporary persistence directories, not the default workspace.

## Next parity criteria

The next slices should harden behavior rather than broaden scope blindly:

1. Add real temp-repo tests for `/api/git/changes` and `/api/git/diff`.
2. Add file route tests for path handling, multipart upload, and download behavior.
3. Add bash timeout/process/event edge-case tests.
4. Add WebSocket smoke coverage for conversation event replay modes and bash event fanout.
5. Compare generated OpenAPI against pinned Python route shapes and document intentional gaps.
6. Keep message-queue/exactly-once semantics out of this package until the separate
   upstream-compatible queue layer is designed.
