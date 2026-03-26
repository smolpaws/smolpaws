# Common ingress turn contract

## Summary

SmolPaws should move to a **server-owned, first-class turn API** for WhatsApp, Discord, and GitHub.

The clean boundary is not “one more shared client library over the current conversation routes.” The clean boundary is:

- **agent-server owns conversation state and turn state**
- **a shared ingress turn client consumes that turn API**
- **channel adapters only deliver outbound messages and final replies**
- **host-runtime control-plane work stays outside the ingress client**

That gives us the behavior we want:

- in-flight tracker summaries can go out while the agent keeps running
- other `send_message` notifications can also go out during the same turn
- the final assistant reply still arrives at the end
- retries and overlapping starts can be reasoned about with turn-scoped ids instead of conversation-wide guesswork

## Why this doc exists

The tracker-summary work exposed a real gap in the current design.

Today:

- `apps/agent-server` can enqueue outbound current-thread messages during a conversation
- WhatsApp/local treats outbound messages as a replacement for the final reply
- Discord has similar replacement-style behavior
- GitHub already returns both outbound messages and final reply, but only by stitching together conversation-wide artifacts after the fact

The underlying problem is broader than any one ingress:

- turn ownership is implicit instead of first-class
- current clients operate on conversation-wide status and reply lookup
- destructive claim endpoints are not scoped to a specific turn
- retry and duplicate-start behavior is not defined by a turn token or idempotency key

If we want a clean ingress foundation, the server has to own turns explicitly.

## Current state

### Shared runtime surface

`apps/agent-server` is already the shared runtime surface for ingresses.

Relevant routes today:

- `POST /api/conversations`
- `GET /api/conversations/:conversationId`
- `POST /api/conversations/:conversationId/events`
- `POST /api/conversations/:conversationId/run`
- `POST /api/conversations/:conversationId/outbound_messages/claim`
- `POST /api/conversations/:conversationId/task_commands/claim`
- `GET /api/conversations/:conversationId/events/search`
- `GET /sockets/events/:conversationId`

Current ingress clients use REST only. They should continue to treat agent-server as the only owner of workspace, persistence, and outbox state.

### Current problems

#### 1. Outbound delivery is not consistently additive

- WhatsApp/local and Discord currently return outbound messages **instead of** the final reply.
- GitHub is closer to the desired model, but only because it assembles outbound messages and reply from separate conversation-wide reads.

#### 2. Turn identity is missing

The current design works at the conversation level, not the turn level.

That means a client cannot prove that:

- a claimed outbound message belongs to the turn it just started
- a fetched reply belongs to the same turn
- a retry did not start the same turn twice
- an undrained stale artifact is not being misattributed to the current request

#### 3. Control-plane artifacts are mixed into ingress design

`task_commands/claim` is not a channel delivery concern. It is a SmolPaws host-runtime concern:

- scheduler changes
- database updates
- local authority decisions

Those operations should not be baked into the core ingress-facing turn client.

#### 4. Dependency direction is backwards

A shared client should not live under `apps/agent-server/src/shared/*`.

That makes future ingresses depend on server-app internals instead of a neutral shared module.

## Goals

1. **Turn-scoped semantics**
   - each user request that starts agent work becomes a first-class turn
   - turn status, outbound artifacts, and final result are all scoped to that turn

2. **Additive delivery**
   - outbound thread messages do not suppress the final assistant reply

3. **One shared ingress turn client**
   - shared orchestration for WhatsApp, Discord, and GitHub
   - channel-specific delivery stays in thin adapters

4. **Clear separation of delivery vs control plane**
   - ingress client handles outbound thread artifacts and final reply
   - host-runtime adapters handle scheduler/database/task-command concerns

5. **Remote-friendly server boundary**
   - ingresses can keep talking to agent-server over HTTP/WS later
   - agent-server can keep running `LocalConversation` wherever it lives

## Non-goals

- redesign `LocalConversation`
- redesign agent-server file/git/bash ownership
- require WebSocket streaming for ingress turns in the first pass
- solve exactly-once delivery for every transient artifact before we fix turn ownership

## Design principles

### 1. Agent-server owns turns

The server, not the client, should define:

- when a turn starts
- which artifacts belong to that turn
- what terminal state that turn reached
- what the final reply for that turn is

### 2. Shared client consumes a turn contract; it does not invent one

The shared client should be simple because the server contract is simple.

It should not reconstruct turn semantics from:

- conversation-wide status
- destructive claim endpoints with no turn id
- event searches over mixed history
- “last assistant reply” heuristics

### 3. Keep channel delivery thin

WhatsApp, Discord, and GitHub should differ only in how they deliver artifacts:

- WhatsApp sends chat messages
- Discord replies in-channel
- GitHub posts comments and may keep duplicate-suppression policy

They should not each own their own runner orchestration rules.

### 4. Keep host-runtime control plane separate

Task commands belong in a separate host-runtime layer.

That layer may share low-level protocol code with the ingress turn client, but it is not the same abstraction.

## Proposed boundary

Introduce two related but separate abstractions.

### A. Shared ingress turn client

This is the channel-neutral client used by WhatsApp, Discord, and GitHub.

It owns:

- dispatching a turn
- polling turn status
- claiming turn-scoped outbound thread messages
- loading the final turn result
- retry logic for safe operations

Suggested shape:

```ts
interface DispatchTurnOptions {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  createConversation?: StartConversationRequest;
  userMessage: MessagePayload;
  idempotencyKey: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onOutboundMessage?: (msg: SmolpawsOutboundMessage) => Promise<void> | void;
}

interface DispatchTurnResult {
  conversationId: string;
  turnId: string;
  status: 'completed' | 'waiting_for_confirmation' | 'paused' | 'error' | 'stuck';
  reply?: string;
  deliveredOutboundCount: number;
}
```

The final reply stays part of the returned result. Each ingress can then apply its own final-delivery policy.

`onOutboundMessage` failures are client-side delivery failures. They should fail the current ingress attempt and be surfaced to the caller, but they should not rewrite server-owned turn state.

### B. Local runtime host adapter

This is a separate local-runtime abstraction for SmolPaws host concerns.

It may additionally handle:

- task-command draining
- scheduler/database mutations
- local authorization checks around task effects

That adapter can be used by WhatsApp/local host code and scheduled-task runtime code, but it should not be part of the core ingress-facing client contract.

## Proposed server API

The target design should add a first-class turn API.

Exact naming can change, but the semantics should look like this.

### 1. Ensure conversation exists

Keep conversation creation separate and side-effect light.

Example:

- `POST /api/conversations`

Responsibilities:

- create or continue the conversation shell
- persist any conversation-level metadata/config
- do **not** implicitly define turn ownership

### 2. Dispatch a turn asynchronously

Add a turn dispatch route.

Examples:

- `POST /api/conversations/:conversationId/turns`
- or `POST /api/turns`

Suggested request fields:

- user message payload
- `idempotency_key`
- optional ingress metadata

Suggested response:

- `conversation_id`
- `turn_id`
- `status` (initial state, typically `running`)
- `accepted_at`
- optional `start_event_id` or `start_cursor`

Dispatch must return immediately after the server has durably accepted the turn. The response should include the initial turn status so the client can begin polling and draining immediately after dispatch succeeds.

### 3. Query turn status

Examples:

- `GET /api/conversations/:conversationId/turns/:turnId`

Suggested status values:

- `running`
- `completed`
- `waiting_for_confirmation`
- `paused`
- `error`
- `stuck`

Status semantics for the first pass:

- `running`: turn is actively being processed
- `completed`: turn finished successfully and the final result is available
- `waiting_for_confirmation`: turn is blocked on user confirmation and counts as an active turn for concurrency purposes
- `paused`: turn is suspended and counts as an active turn for concurrency purposes
- `error`: turn failed and the result endpoint should expose error details if available
- `stuck`: turn hit runner-level stuck detection and should be treated as terminal for this turn; callers should not assume the same idempotency key can restart useful work

### 4. Claim turn-scoped outbound thread messages

Examples:

- `POST /api/conversations/:conversationId/turns/:turnId/outbound_messages/claim`

These artifacts are ingress-delivery artifacts only.

Turn-scoped means the claimed artifacts belong to that turn, not to the whole conversation history. It does **not** imply idempotent re-reads in v1.

### 5. Load turn result

Examples:

- `GET /api/conversations/:conversationId/turns/:turnId/result`

Suggested result:

- terminal status
- final assistant reply, if any
- optional metadata like finish timestamp

### 6. Optional host-runtime artifacts

If task commands need the same turn scoping, expose them separately from the ingress contract.

Examples:

- `POST /api/conversations/:conversationId/turns/:turnId/task_commands/claim`

But this should be documented as a **host-runtime adapter** concern, not an ingress turn client concern.

## Per-conversation concurrency policy

For the first pass, the server should own a simple rule:

- **one active turn per conversation**

Dispatch behavior:

- if a dispatch arrives with the same `(conversation_id, idempotency_key)` as an already accepted turn, return the same accepted turn
- if a dispatch arrives with a different `idempotency_key` while another turn is `running`, `waiting_for_confirmation`, or `paused`, return `409` with at least:
  - `active_turn_id`
  - `status`
- if a turn is `completed`, `error`, or `stuck`, a new dispatch may create a new turn normally

If queued turns are wanted later, they should be added as an explicit **server-owned queue**, not as client behavior.

## Canonical ingress turn lifecycle

With the turn API above, the shared client becomes straightforward.

1. ensure the conversation exists
2. dispatch the turn with an `idempotency_key`
3. receive `turn_id`
4. while turn status is `running`:
   - poll `GET /api/conversations/:conversationId/turns/:turnId`
   - claim `POST /api/conversations/:conversationId/turns/:turnId/outbound_messages/claim`
   - deliver outbound messages immediately via `onOutboundMessage`
5. once the turn is terminal:
   - do one final outbound drain
   - fetch `GET /api/conversations/:conversationId/turns/:turnId/result`
   - return the final reply and final status

That is enough for in-flight summaries and additive final replies.

## Retry and idempotency rules

The shared client should document retry behavior explicitly.

### Safe to retry

- `GET` turn status
- `GET` turn result
- conversation lookup/read endpoints

### Safe to retry with the same idempotency key

- turn dispatch

The server must guarantee that the same `(conversation_id, idempotency_key)` pair resolves to the same accepted turn instead of starting a duplicate turn.

### Not safe to retry blindly

- legacy `POST /api/conversations/:id/events`
- legacy `POST /api/conversations/:id/run`

Those routes do not give the client enough turn identity to retry without ambiguity.

### Artifact claim retries

For a first pass, turn-scoped outbound claims may remain destructive and best-effort.

That means:

- the endpoint is still scoped to `turn_id`, so it cannot mix artifacts from another turn
- a successful claim may remove those artifacts from future reads
- a retry after a successful claim may legitimately return `[]`
- if an ingress crashes after claim and before delivery, those artifacts may be lost in v1

That limitation is acceptable for the first pass if it is explicit. If stronger guarantees become necessary later, we can add lease/ack semantics without changing the basic turn boundary.

## Relationship to existing routes

The current conversation-scoped routes are still useful for:

- UI clients
- compatibility during migration
- ad hoc inspection and debugging

But they should not remain the long-term ingress foundation for in-flight delivery.

If needed, they can support a transitional adapter. The target design should still be the first-class turn API above.

## Module and dependency direction

The new shared client should live in a channel-neutral home, not under `apps/agent-server`.

A clean direction would be:

- dedicated shared module/package for runner wire types and turn client
- `apps/agent-server` depends on the shared wire types
- WhatsApp, Discord, and GitHub depend on the shared turn client

The important constraint is directional:

- ingresses should not import client abstractions from inside the server app they are consuming

## WebSocket

WebSocket event streaming stays optional.

For ingress turns, REST is enough if the server exposes a proper asynchronous turn API.

A later optimization could add:

- turn-specific event streaming
- lower-latency status updates

But that is an optimization, not the core abstraction.

## Migration plan

### Step 1

Update the design target from “shared client over conversation routes” to “shared client over a first-class turn API.”

### Step 2

Add server-owned turn routes and turn ids while keeping existing conversation routes working.

### Step 3

Implement a channel-neutral shared ingress turn client in its own shared module/package.

### Step 4

Move WhatsApp to the new shared client for outbound in-flight delivery plus final reply.

### Step 5

Move Discord to the same client.

### Step 6

Move GitHub to the same client, keeping any GitHub-specific duplicate suppression in the delivery layer.

### Step 7

Keep task-command draining in a local runtime adapter and remove task-command handling from the ingress client surface.

### Step 8

Retire the misleading partial abstractions and duplicated per-ingress orchestration.

That includes:

- most of `src/agent-runtime/local-agent-server.ts` as a custom turn client
- `apps/discord/src/agentServerClient.ts` as an independent orchestration layer
- `apps/github/src/agentServerClient.ts` as an independent orchestration layer
- `src/agent-runtime/shared-runner.ts` as a would-be shared client foundation

## What success looks like

After this work:

- WhatsApp can send tracker summaries and other `send_message` output during a turn and still send the final answer afterward
- Discord follows the same turn contract
- GitHub uses the same shared turn client even if its posting policy stays quieter
- ingress code does not guess at turn boundaries from conversation history
- host-runtime control-plane work stays outside the ingress client contract
- agent-server remains free to run `LocalConversation` wherever it lives

## Recommendation

Be bolder at the server boundary.

The clean abstraction is:

- **first-class server-owned turns**
- **one shared ingress turn client over that API**
- **a separate host-runtime adapter for task commands and other local control-plane effects**

Anything weaker still simplifies some code, but it leaves the hardest semantic problem unsolved.
