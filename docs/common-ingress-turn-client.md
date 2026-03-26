# Common ingress turn contract

## Summary

SmolPaws should move to a **server-owned, first-class turn API** for WhatsApp, Discord, and GitHub.

The clean boundary is:

- **agent-server owns conversation state and turn state**
- **a shared ingress turn client consumes that API**
- **channel adapters only deliver outbound thread messages and final replies**
- **host-runtime control-plane work stays outside the ingress client**

That gives us the behavior we actually want:

- in-flight tracker summaries can go out while the agent keeps running
- other `send_message` notifications can also go out during the same turn
- the final assistant reply still arrives at the end
- additional user messages for the same conversation can be accepted during the active turn
- retries and overlapping message submissions can be reasoned about with server-owned ids instead of conversation-wide guesswork

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
- retry and duplicate-start behavior is not defined by server-owned turn and message identities

If we want a clean ingress foundation, the server has to own turns explicitly.

## Turn definition

A **turn** is a server-owned execution span on a single conversation.

For the first pass:

- if the conversation is **not running**, an accepted user message starts a new turn
- while that turn is active, additional user messages for the same conversation may still be accepted
- those additional user messages belong to the same active turn
- once the turn reaches a terminal state, the next accepted user message starts the next turn on that same conversation id

So a turn is **not** “exactly one user message.”
It is an execution span that starts from a user message on an idle conversation and runs until the agent reaches a terminal state for that span.

## Core invariants

### Transcript invariants

- The persisted conversation transcript is the durable source of truth for what happened.
- Accepted user messages, assistant messages, tool actions/results, and terminal events all belong to that one transcript.
- A turn is metadata over a span of that transcript; it is not a separate shadow history.
- Restore/reconnect may rebuild state from `conversation_id` plus transcript history alone.
- UI presentation may collapse or summarize parts of history, but it must not invent a different ordering than the persisted event log.

### Turn invariants

- A turn is server-owned and belongs to exactly one conversation.
- A turn starts when a user message is accepted on a conversation that was not running.
- While that turn is active, additional accepted user messages may still belong to that same turn.
- A turn ends only when the server records a terminal turn state for that execution span.
- After a turn is terminal, the next accepted user message on that conversation starts the next turn.
- Turn-scoped outbound artifacts and final result must be attributable to exactly one `turn_id`.

### Delivery-owner invariants

- Message submission and turn delivery are distinct concerns.
- Many submitters may attach user messages to one active turn.
- At most one server-recognized delivery owner may claim outbound thread messages and own final-reply delivery for a turn at a time.
- A caller may submit a message that binds to an existing active turn without becoming that turn's delivery owner.
- Reading transcript, turn status, or turn result for debugging/recovery does not require delivery ownership; claiming outbound delivery artifacts does.
- The exact v1 ownership mechanism is intentionally left open here. The invariant matters more than whether v1 uses a simple owner field, a takeover endpoint, or a later lease/token design.

### Recovery invariants

- Watcher death, process restart, server restart, and mid-turn interruption are all normal cases.
- If an active turn resumes safely after restart, it keeps the same `turn_id`.
- If an active turn cannot resume safely, the server marks it terminal (`error`, `stuck`, or equivalent interrupted-style status); it must not remain phantom-`running` forever.
- Once the last turn is terminal, a later caller may reconnect to the same `conversation_id`, submit a new user message, and start the next turn normally.
- Idempotency applies to message acceptance/binding: retrying the same `(conversation_id, idempotency_key)` must resolve to the same accepted message/turn binding, not duplicate the message.

### Safe-boundary insertion invariant

- User messages accepted during an active turn should enter the transcript as soon as possible, but only at a safe execution boundary.
- The server must never splice a new user message between an `ActionEvent` and its matching `ObservationEvent`.
- Transcript ordering should reflect real acceptance order, subject to that safety constraint.

### Product invariant

- In-flight outbound thread messages are additive, not a replacement path.
- The final assistant reply for a turn remains deliverable after in-flight messages have already been sent.
- Multiple accepted user messages during one turn may influence that final reply; the final reply is for the execution span of the turn, not necessarily only for the first message that started it.

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

- a claimed outbound message belongs to the active turn it cares about
- a fetched reply belongs to that same turn
- a retry did not submit the same user message twice
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
   - turn status, outbound artifacts, and final result are all scoped to a server-owned turn id

2. **Additive delivery**
   - outbound thread messages do not suppress the final assistant reply

3. **Chat-native message acceptance**
   - additional user messages for the same conversation are accepted while a turn is active
   - they are attached to the active turn instead of starting a parallel one

4. **One active executor per conversation**
   - there is never more than one active agent run loop for a conversation at a time

5. **Clear separation of delivery vs control plane**
   - ingress client handles outbound thread artifacts and final reply
   - host-runtime adapters handle scheduler/database/task-command concerns

6. **Remote-friendly server boundary**
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
- which messages and artifacts belong to that turn
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

It has two logical responsibilities:

- **submitter**: submit a user message, learn which turn now owns it, and learn whether that message started a new turn
- **delivery owner**: if this caller is the current server-recognized delivery owner for the turn, poll turn status, claim outbound thread messages, and deliver the final reply

Not every submitter becomes the delivery owner. Many submitters may bind messages to one active turn, but only one caller at a time may own delivery for that turn.

Suggested shape:

```ts
interface SubmitConversationMessageOptions {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  createConversation?: StartConversationRequest;
  userMessage: MessagePayload;
  idempotencyKey: string;
}

interface SubmitConversationMessageResult {
  conversationId: string;
  turnId: string;
  messageEventId: string;
  startedNewTurn: boolean;
  status: 'running' | 'completed' | 'waiting_for_confirmation' | 'paused' | 'error' | 'stuck';
}

interface PumpTurnOptions {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  turnId: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onOutboundMessage?: (msg: SmolpawsOutboundMessage) => Promise<void> | void;
}

interface PumpTurnResult {
  conversationId: string;
  turnId: string;
  status: 'completed' | 'waiting_for_confirmation' | 'paused' | 'error' | 'stuck';
  reply?: string;
  deliveredOutboundCount: number;
}
```

The final reply stays part of the returned turn result. Each ingress can then apply its own final-delivery policy.

`onOutboundMessage` failures are client-side delivery failures. They should fail the current delivery-owner attempt and be surfaced to the caller, but they should not rewrite server-owned turn state.

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

Keep conversation creation separate and side-effect-light.

Example:

- `POST /api/conversations`

Responsibilities:

- create or continue the conversation shell
- persist any conversation-level metadata/config
- do **not** implicitly define turn ownership

### 2. Submit a user message to the conversation

Add a user-message submission route that returns turn information.

Examples:

- `POST /api/conversations/:conversationId/turns`
- `POST /api/conversations/:conversationId/messages`
- or `POST /api/turns`

The exact route name matters less than the contract.

Suggested request fields:

- user message payload
- `idempotency_key`
- optional ingress metadata

Suggested response:

- `conversation_id`
- `turn_id`
- `message_event_id`
- `status` (initial state; typically `running` for an active turn)
- `started_new_turn`
- `accepted_at`
- optional `safe_after_event_id` or equivalent cursor metadata

Submission must return immediately after the server has durably accepted the user message.

Server behavior:

- if the conversation is idle, accept the message, start a new turn, and return its `turn_id`
- if the conversation already has an active turn, accept the message into that active turn and return the existing `turn_id`
- if the same `(conversation_id, idempotency_key)` arrives again, return the same accepted message/turn binding instead of duplicating the message

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
- `waiting_for_confirmation`: turn is blocked on user confirmation and is terminal for this turn until a confirmation response arrives
- `paused`: turn is suspended and is terminal for this turn until a resume arrives
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

### 7. Delivery ownership

The server must expose enough information for callers to avoid competing delivery ownership for one turn.

For the first pass, this doc requires the invariant, not a specific mechanism:

- many callers may submit messages that bind to one active turn
- at most one caller at a time may be recognized as the delivery owner for that turn
- only that delivery owner may claim outbound thread messages for delivery
- final-reply delivery for that turn belongs to that same delivery owner
- a later caller may become the delivery owner during recovery after restart or lost ownership

That ownership signal may be exposed in the submission response, in turn status, or through a separate takeover API. The exact v1 mechanism is intentionally left open here.

## Active-turn message acceptance policy

For the first pass, the server should own these rules:

- **one active executing turn per conversation**
- **additional user messages for that conversation are still accepted while that turn is active**
- those messages are attached to the active turn instead of creating a parallel one
- once the turn reaches a terminal state, the next accepted user message starts the next turn

This is the important distinction:

- one active **turn/executor** per conversation
- not one active **user message** per conversation

If explicit server-owned turn queues are wanted later, they can be added as a follow-up. They should not be simulated by ingress code.

## Safe insertion boundary for user messages

User messages accepted during an active turn should be reflected in the conversation event log at the time they were accepted, but only at a safe boundary.

For the first pass, the rule should be:

- persist the acceptance time immediately
- append the resulting `MessageEvent(source="user")` at the next safe boundary in the execution loop
- **never** splice a new user message between an `ActionEvent` and its matching `ObservationEvent`
- insert after the current step closes, which in practice means after the current observation/result and before the next tool call or next agent step

This preserves the integrity of action/observation pairs while still giving the conversation history the right arrival order.

## Canonical ingress turn lifecycle

With the turn API above, the shared client becomes straightforward.

1. ensure the conversation exists
2. submit the user message with an `idempotency_key`
3. receive `turn_id`, `message_event_id`, whether a new turn was started, and enough server-owned information to know whether this caller is the current delivery owner
4. if this caller is the current delivery owner for that turn:
   - poll `GET /api/conversations/:conversationId/turns/:turnId`
   - claim `POST /api/conversations/:conversationId/turns/:turnId/outbound_messages/claim`
   - deliver outbound messages immediately via `onOutboundMessage`
5. once the turn is terminal and this caller is still the delivery owner:
   - do one final outbound drain
   - fetch `GET /api/conversations/:conversationId/turns/:turnId/result`
   - return the final reply and final status
6. if this caller is not the delivery owner, return the message-submission acknowledgment only and do not compete for delivery

Additional user messages accepted during that time may return the same `turn_id`, because they belong to the already active turn.

## Retry and idempotency rules

The shared client should document retry behavior explicitly.

### Safe to retry

- `GET` turn status
- `GET` turn result
- conversation lookup/read endpoints

### Safe to retry with the same idempotency key

- user-message submission

The server must guarantee that the same `(conversation_id, idempotency_key)` pair resolves to the same accepted message/turn binding instead of duplicating the user message.

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

For ingress turns, REST is enough if the server exposes the asynchronous submission and turn-status API above.

A later optimization could add:

- turn-specific event streaming
- lower-latency status updates

But that is an optimization, not the core abstraction.

## Migration plan

### Step 1

Keep the target as a first-class turn API, but refine the turn definition to match chat reality: one active turn may contain multiple user messages.

### Step 2

Add server-owned turn routes, turn ids, and message-submission ids while keeping existing conversation routes working.

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
- WhatsApp can also accept another user message mid-turn without starting a parallel executor
- Discord follows the same turn contract
- GitHub uses the same shared turn client even if its posting policy stays quieter
- ingress code does not guess at turn boundaries from conversation history
- host-runtime control-plane work stays outside the ingress client contract
- agent-server remains free to run `LocalConversation` wherever it lives

## Recommendation

Keep the server-owned turn boundary, but define turns the way chat systems actually behave.

The clean abstraction is:

- **first-class server-owned turns**
- **one active executing turn per conversation**
- **additional user messages may still be accepted into that active turn**
- **one shared ingress turn client over that API**
- **a separate host-runtime adapter for task commands and other local control-plane effects**

Anything weaker still simplifies some code, but it leaves the hardest semantic problem unsolved.
