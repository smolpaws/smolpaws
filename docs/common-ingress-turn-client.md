# Common ingress turn client

## Summary

SmolPaws should use one shared ingress-facing turn client for WhatsApp, Discord, and GitHub.

That client should treat outbound artifacts (`send_message`, tracker summaries, future in-flight notifications) and the final assistant reply as **additive**, not mutually exclusive. It should speak to `apps/agent-server` over the existing API surface, keep all workspace and persistence ownership inside the agent-server, and leave only the final delivery step channel-specific.

The first implementation should stay simple:

- keep agent-server as the only owner of `LocalConversation`, workspace access, persistence, outbox, and task-command files
- use one shared polling/draining orchestration for ingress turns
- deliver outbound messages via callbacks while the turn is active
- fetch the final assistant reply after the turn finishes
- avoid ingress-specific file watching and avoid adding a second half-shared client layer

A small follow-up agent-server API cleanup may still be worthwhile, but the main problem is duplicated client orchestration, not missing persistence features.

## Why this doc exists

The tracker-summary work exposed a real contract mismatch:

- `apps/agent-server/src/agent-server/conversationRuntime.ts` can enqueue current-thread outbound messages during a turn
- `src/agent-runtime/local-agent-server.ts` currently treats any outbound message as a replacement for the final reply
- `src/index.ts` then sends those outbound messages to WhatsApp and stops

That replacement contract blocks the product direction we actually want:

- in-flight summaries may go out while the agent continues
- other `send_message` notifications may also go out mid-turn
- the final assistant answer should still arrive at the end

At the same time, the repo already has several different client implementations over the same agent-server shape:

- `src/agent-runtime/local-agent-server.ts`
- `apps/discord/src/agentServerClient.ts`
- `apps/github/src/agentServerClient.ts`
- `src/agent-runtime/shared-runner.ts` as an older partial convergence path

They do similar work, but they do not share one contract.

## Current state

### What is already common

`apps/agent-server` is already the shared runtime surface for ingresses.

Current capabilities:

- `POST /api/conversations`
- `GET /api/conversations/:conversationId`
- `POST /api/conversations/:conversationId/events`
- `POST /api/conversations/:conversationId/run`
- `POST /api/conversations/:conversationId/outbound_messages/claim`
- `POST /api/conversations/:conversationId/task_commands/claim`
- `GET /api/conversations/:conversationId/events/search`
- `GET /sockets/events/:conversationId`

The current ingress clients use REST only. None of them should read outbox files directly.

### What is not common today

Each ingress still owns its own turn orchestration logic.

#### WhatsApp

`src/agent-runtime/local-agent-server.ts`:

- creates or continues a conversation
- waits for execution to stop running
- claims task commands
- claims outbound messages
- if any outbound messages exist, returns early with `result: null`
- otherwise loads the latest assistant reply from events

This makes outbound delivery a **replacement path**.

#### Discord

`apps/discord/src/agentServerClient.ts`:

- waits for completion by polling `/api/conversations/:id`
- claims outbound messages once
- if outbound messages exist, returns them and omits the reply
- otherwise loads the latest assistant reply

This also behaves as a replacement path.

#### GitHub

`apps/github/src/agentServerClient.ts`:

- posts the conversation request
- claims outbound messages
- separately fetches the latest assistant reply from events
- returns both to the worker

GitHub is already closer to the desired additive model, but only **after** the turn has finished.

#### `shared-runner.ts`

`src/agent-runtime/shared-runner.ts` also returns both outbound messages and final reply, but it is not the runtime path currently selected by `src/agent-runtime/index.ts` and it does not provide the common abstraction we need for in-flight delivery.

## Goals

1. **One turn contract for ingresses**
   - start a turn
   - observe progress
   - drain outbound artifacts
   - process task commands
   - return the final assistant reply

2. **Additive semantics**
   - outbound messages do not suppress the final reply
   - the final reply remains durable via conversation events

3. **In-flight delivery for chat-like ingresses**
   - WhatsApp and Discord should be able to send tracker summaries and other `send_message` output while the agent is still running

4. **No ingress access to runner internals**
   - no directory watching
   - no JSONL file reads from ingress code
   - no channel-specific persistence logic

5. **Keep remote migration straightforward**
   - the whole agent-server can later move to a remote machine and keep running `LocalConversation` there
   - ingresses should still work by talking to it over HTTP and, where useful, WebSocket

6. **Do not break the existing UI/client surface**
   - `RemoteConversation` and other synchronous/UI-oriented agent-server routes should keep working

## Non-goals

- redesign `LocalConversation`
- redesign the outbox persistence format in this first pass
- make GitHub stream comments in real time immediately
- replace every existing route with a brand-new API before proving the common client
- solve stronger-than-current delivery guarantees for transient outbound messages

## Design principles

### 1. Agent-server owns state; ingresses own delivery

The agent-server remains responsible for:

- `LocalConversation`
- workspace and repo access
- bash/file/git execution on the runner host
- conversation persistence
- outbound message persistence
- task-command persistence

Ingresses remain responsible only for:

- turning a user request into a conversation turn request
- delivering claimed outbound artifacts to the channel
- delivering the final reply to the channel
- channel-local niceties like typing indicators or duplicate suppression

### 2. One shared client, thin channel adapters

We should have exactly one ingress-facing turn client abstraction.

That shared client should own:

- conversation start/continue semantics
- turn start semantics
- status polling
- artifact draining
- final reply loading
- timeout and retry policy

Channel adapters should only provide callbacks such as:

- `onOutboundMessage`
- `onTaskCommand`
- `onFinalReply`

### 3. Prefer protocol reuse over transport cleverness

The first version should use the existing REST surface.

WebSocket event streaming can remain available for UI clients and may later reduce polling cost, but it should not be required to land the common ingress abstraction.

### 4. Keep the common layer channel-neutral

The common client should not know about:

- WhatsApp JIDs
- Discord message objects
- GitHub issue comments
- worker retry APIs

It should only know about runner requests, runner statuses, runner outbound messages, task commands, and final reply text.

## Proposed abstraction

Introduce a shared ingress turn client with two layers.

### Layer 1: agent-server turn primitives

A fetch-only helper over the agent-server HTTP surface.

Suggested responsibilities:

- `createOrContinueConversation(...)`
- `enqueueUserMessage(...)`
- `startQueuedRun(...)`
- `getConversationInfo(...)`
- `claimOutboundMessages(...)`
- `claimTaskCommands(...)`
- `loadLatestAssistantReply(...)`

Important constraints:

- no Node-only APIs in this layer
- no channel-specific behavior
- no workspace provisioning logic

This layer can live in a repo-local shared module for now. Since multiple packages already import shared types from `apps/agent-server/src/shared/*`, the first cut can colocate here if needed, but it should be treated as a transitional location, not a final architectural destination.

### Layer 2: ingress turn orchestrator

A higher-level helper that uses the primitives above to run one ingress turn.

Suggested shape:

```ts
interface RunIngressTurnOptions {
  baseUrl: string;
  authToken?: string;
  conversationId: string;
  createRequest: StartConversationRequest;
  userMessage: MessagePayload;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onOutboundMessage?: (msg: SmolpawsOutboundMessage) => Promise<void> | void;
  onTaskCommand?: (cmd: SmolpawsTaskCommand) => Promise<void> | void;
}

interface RunIngressTurnResult {
  conversationId: string;
  executionStatus: string;
  reply?: string;
  deliveredOutboundCount: number;
  claimedTaskCommandCount: number;
}
```

Core behavior:

1. ensure the conversation exists
2. enqueue the user message for the turn
3. start the run
4. while the conversation is active:
   - poll status
   - claim outbound messages and deliver them through callbacks
   - claim task commands and hand them off through callbacks
5. once the conversation reaches a terminal turn state:
   - do one final drain of outbound messages and task commands
   - load the latest assistant reply from events
   - return both the final status and final reply

The orchestrator is where we make outbound and final reply additive by design.

## Canonical turn lifecycle

### Recommended first-cut lifecycle

The common client should use the canonical conversation path, not runner-local shortcuts.

#### 1. Ensure the conversation exists

Use `POST /api/conversations` with a caller-selected stable `conversation_id`.

For the first cut, keep this explicit and non-magical:

- if the ingress already has a stable conversation id, reuse it
- otherwise generate one before the request
- keep the create request free of side effects where possible

#### 2. Queue the user message without running immediately

Use `POST /api/conversations/:id/events` with:

- `role: "user"`
- `content: [...]`
- `run: false`

This gives the common client an explicit queued-turn boundary.

#### 3. Start the turn

Use `POST /api/conversations/:id/run`.

For the first version, the orchestrator can treat this as the run-start request even if the current server implementation waits for the run to complete before returning.

Because the current route is synchronous, the common client should keep explicit turn-start state and must not treat an initial `idle` poll result as turn completion before the queued run request has been accepted.

#### 4. Pump artifacts while the turn is active

In a loop:

- `GET /api/conversations/:id`
- `POST /outbound_messages/claim`
- `POST /task_commands/claim`

Deliver artifacts immediately through the supplied callbacks.

#### 5. Finish cleanly

After the turn reaches a terminal state:

- perform one last drain of both claim endpoints
- fetch the final assistant reply via `GET /events/search`
- return the reply and final status

### Why this lifecycle

This form keeps the abstraction simple:

- one durable conversation id
- one queued user message per turn
- one explicit run boundary
- one common pump loop for outbound artifacts and task commands

It also avoids encoding channel-specific assumptions into the start step.

## Recommended agent-server cleanup

The common client can be built over the current routes, but one small API cleanup would make it cleaner.

### Add a non-blocking turn-dispatch route

Current `POST /api/conversations` and `POST /api/conversations/:id/run` are synchronous from the client's point of view. That forces ingress clients to either:

- wait for the whole run before doing anything else, or
- keep a long-lived request open while separately polling the same conversation

A cleaner runner contract would add a non-blocking dispatch route, for example:

- `POST /api/conversations/dispatch`

Suggested behavior:

- create or continue a conversation
- accept a user message for the turn
- start the run asynchronously
- return immediately with conversation info and a 202-style success response

This would let the common client start a turn without long-lived background requests.

### Why this is optional, not blocking

We do not need a new route to unify the clients. The shared polling/draining orchestration is the real missing abstraction.

The new route is a cleanup that makes the common implementation easier and cheaper, especially for remote or worker-style ingresses.

## Status model for the common client

The common client should define a turn-terminal status set and stop special-casing by ingress.

### Active states

- `running`

### Turn-terminal states

- `idle`
- `finished`
- `error`
- `stuck`
- `paused`
- `waiting_for_confirmation`

`waiting_for_confirmation` should be treated as terminal for the current turn pump. The turn has stopped making forward progress and now requires a follow-up action.

## Outbound artifact semantics

### Current contract

`outbound_messages/claim` and `task_commands/claim` are destructive claims.

That means the current delivery model is best-effort:

- once claimed, the runner considers the artifact handed off
- if the ingress crashes after claiming but before delivering, the artifact may be lost

### Recommendation for this design

Do not change that contract in the first pass.

Rationale:

- the main product problem is inconsistent client orchestration
- final assistant replies are already durable in conversation events
- tracker summaries and `send_message` notifications are useful, but they do not need a full lease/ack protocol before we can unify the ingress design

### Explicit limitation

In-flight outbound delivery remains best-effort until we add a lease/ack artifact protocol. That is acceptable for the first pass and should be documented, not hidden.

## Delivery policies per ingress

The common client should expose one delivery contract while allowing light channel policy differences.

### WhatsApp

Desired behavior:

- send outbound messages as they are claimed
- continue pumping while the agent runs
- send the final reply when the turn ends

### Discord

Desired behavior:

- same model as WhatsApp
- outbound messages are sent immediately
- final reply still goes out at the end

### GitHub

Desired behavior for the first pass:

- still use the same common turn client
- allow the worker to choose whether to post outbound messages immediately or buffer them until completion
- keep duplicate-suppression logic for the final reply in the GitHub delivery layer

This means the common client is shared even if the posting policy differs.

## Relation to WebSocket events

The server already exposes `/sockets/events/:conversationId` and UI clients use it for event streaming.

For ingress turns, WebSocket should stay optional.

### First pass

- use REST polling for status and artifact drains
- keep the turn client simple and uniform across host and worker environments

### Later optimization

A later version could use WebSocket events to reduce status polling or to observe assistant events more quickly, while still using REST claims for outbound artifacts.

That optimization should not change the turn contract.

## Proposed code movement

### Introduce one shared turn client

Add a new shared module for ingress turn orchestration and move logic into it from:

- `src/agent-runtime/local-agent-server.ts`
- `apps/discord/src/agentServerClient.ts`
- `apps/github/src/agentServerClient.ts`
- selective reusable pieces from `src/agent-runtime/shared-runner.ts`

### Keep runner bootstrap separate

`src/agent-runtime/local-runner.ts` should stay focused on locating or starting the local agent-server.

It should not own turn orchestration.

### Retire the misleading partial abstraction

`src/agent-runtime/shared-runner.ts` should not become the long-term common turn client.

It mixes:

- workspace provisioning
- runner bootstrapping
- turn orchestration
- a now-unused runtime path

Useful code can be moved out, but the file itself should be reduced or removed rather than expanded.

## Migration plan

### Step 1: land the shared primitives and orchestrator

No behavior change yet.

### Step 2: migrate WhatsApp to the common turn client

This is the highest-value migration because it unlocks:

- in-flight tracker summaries
- in-flight `send_message` delivery
- preserved final replies

### Step 3: migrate Discord to the same client

This removes another replacement-style client.

### Step 4: migrate GitHub to the same client

GitHub can keep its channel-specific reply suppression, but it should stop owning its own runner orchestration.

### Step 5: remove or shrink obsolete paths

At that point:

- `local-agent-server.ts` becomes a thin adapter around runner bootstrap + shared turn client
- `shared-runner.ts` can be retired or reduced to pure workspace provisioning helpers if still needed elsewhere

## Risks and tradeoffs

### Polling cost

A shared pump loop means more deliberate polling.

This is acceptable because:

- the same work is already duplicated across clients today
- polling intervals can stay modest
- WebSocket remains a later optimization

### Best-effort outbound delivery

Destructive claims remain best-effort for transient artifacts.

This is acceptable for the first pass, but the limitation should remain visible in the design.

### Server-route overlap during migration

The common client may temporarily coexist with the existing per-ingress clients and with the current synchronous routes.

That is fine as long as the direction is clear: one shared client should replace the per-ingress turn orchestration, not join it as another special case.

## What success looks like

After this work:

- WhatsApp can send tracker summaries or other `send_message` output during a turn and still deliver the final answer afterward
- Discord follows the same additive contract
- GitHub uses the same runner turn client, even if it chooses a quieter posting policy
- ingress code never reads runner outbox files directly
- agent-server remains free to run `LocalConversation` locally today or on a remote runner later
- SmolPaws has one clear ingress-turn abstraction instead of several almost-the-same clients

## Recommendation

Build one common ingress turn client now.

Use the existing agent-server REST surface for the first pass, keep WebSocket optional, keep outbound delivery additive with the final reply, and remove duplicated ingress orchestration instead of adding another partial abstraction.
