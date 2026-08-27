# Message Relay — Current Design

The Message Relay is SmolPaws-owned infrastructure around the upstream-shaped OpenHands agent-server. It is **not** part of the Python→TypeScript transpilation and should not be judged by source parity.

Its job is to make external message intake and delivery durable without pushing queue semantics into `packages/openhands-agent-server`. The core class is `MessageRelay` (in `src/coordinator/messageRelay.ts`); the directory name `src/coordinator/` is historical.

## Ownership

- **Agent-server EventLog:** source of truth for conversations, events, and agent execution state.
- **Message Relay SQLite store:** source of truth for external work: intake deduplication, lane→conversation mapping, ordering, claims, retries/backoff, delivery outcomes, outbox catch-up cursors, and audit state.
- **Bridge / Delivery Target:** canonical lane identity, platform formatting, the actual platform send, and platform-specific reconciliation when available.

One fact should have one owner. The Message Relay must not duplicate the agent-server execution state machine.

## Integration target

The Message Relay talks to `packages/openhands-agent-server` through the narrow `AgentServerClient` interface. The old `apps/agent-server` `/turns` runner is migration/reference code, not the target architecture.

The current agent-server extension `EXT-SERVER-001` allows an optional deterministic caller-supplied `event_id` on `POST /events`. This closes the intake append-response-loss window without moving queue behavior into agent-server.

## Durable model

The SQLite store keeps:

- a persisted `lanes` directory mapping a canonical external lane to one agent-server conversation;
- a unified `work` table for `intake` and `delivery` rows;
- monotonically increasing per-lane/per-kind sequence numbers;
- state, availability time, claim owner/expiry, generation fence, attempts, send-attempt fence, errors, external message IDs, and immutable payloads;
- per-conversation cursors used by `syncDeliveryOutbox()`.

## Intake invariant

A platform message has a stable `source_key` and deterministic agent event ID.

```text
bridge input
  -> resolve/ensure lane conversation
  -> accept durable intake row (idempotent)
  -> claim lane head
  -> append deterministic user event with run=true
  -> settle done/retry/failed
```

If the append succeeds but the response is lost, retrying the same deterministic `event_id` is safe: agent-server returns the existing event instead of creating another user turn.

## Outbound Relay

The outbound half has two explicit responsibilities:

```text
agent-server EventLog
  -> OutboundRelay.syncDeliveryOutbox()
  -> durable delivery outbox
  -> DeliveryDispatcher
  -> platform DeliveryTarget
```

### `syncDeliveryOutbox()`

`OutboundRelay.syncDeliveryOutbox(conversationId)` reads new durable agent events and inserts corresponding delivery rows with a unique source identity based on agent event plus destination lane.

Delivery rows are inserted before the catch-up cursor advances. If the process crashes between those operations, replay is safe because the unique work identity makes re-insertion a no-op.

The extraction policy is explicit. The reusable Message Relay supports explicit outbound-intent events, while the first Slack canary uses the successful terminal `finish` observation as its chat reply. A plain assistant `MessageEvent` is not terminal in this SDK: the conversation continues until `finish`, cancellation, error, or another terminal state.

### Delivery Dispatcher

The Delivery Dispatcher owns the external side-effect boundary:

```text
claim delivery lane-head
  -> validate target and payload
  -> durably mark send_attempted
  -> invoke platform DeliveryTarget
  -> settle done / failed / delivery_unknown
```

Only the unresolved lane head is claimable, so later work cannot silently overtake earlier work in the same lane.

A delivery worker must durably mark `send_attempted` immediately before invoking the external platform:

- expired claim with `send_attempted = 0` → safe to make ready again;
- expired claim with `send_attempted = 1` → `delivery_unknown`; never blindly retry an external effect that may already have happened.

`delivery_unknown` blocks later delivery in the lane until reconciled or explicitly resolved.

## Claim and retry invariant

Claims are fenced by generation plus claim expiry. Stale workers cannot settle work after another worker has reclaimed it.

Retryable failures use durable backoff and eventually become `failed` after the configured attempt budget. Non-retryable failures fail directly.

## Testing and live proof

The Message Relay core is covered with deterministic real-SQLite tests for:

- duplicate intake acceptance;
- lane persistence/concurrent resolution;
- head-of-line ordering;
- fenced claims and claim expiry;
- retries/backoff/exhaustion;
- `delivery_unknown` versus safe retry;
- operator resolution paths;
- delivery-outbox catch-up, replay, pagination, and cursor behavior.

Slack adds deterministic end-to-end tests that run the real in-process TypeScript agent-server with a test LLM, execute a `finish` tool call, synchronize the delivery outbox, dispatch through a Slack Delivery Target, and verify the durable intake/delivery rows.

On 2026-08-16 an isolated, self-expiring canary at fork commit `a69456fc6f818f23ecb6e2e064f3e03fceeafaf4` also completed the real Liberty Labs Socket Mode path. The distinctive response `RELAY-LIVE-a69456fc6f81` travelled through:

```text
Slack event
  -> greenfield SlackBridge
  -> durable Message Relay intake
  -> real TypeScript agent-server and agent loop
  -> terminal finish observation
  -> syncDeliveryOutbox()
  -> DeliveryDispatcher
  -> SlackDeliveryTarget
  -> Slack thread reply
```

The canary used a deterministic test LLM and isolated checkout/state/port, so it proves the complete transport and durability architecture without claiming that the normal long-running `paws` process or a real provider has completed its production soak.

## Slack canary

`apps/slack` is the first authoritative bridge implementation of the complete path. It is greenfield and deliberately does not preserve its unused legacy `/turns` dispatch shape.

The first canary generation uses:

- database `~/.smolpaws/coordinator/slack-relay-v1.db`;
- a versioned deterministic conversation namespace, separate from earlier shadow experiments;
- the TypeScript agent-server on port `8790` by default;
- `SlackRelayRuntime` for intake and worker loops;
- `OutboundRelay.syncDeliveryOutbox()`;
- `DeliveryDispatcher` plus `SlackDeliveryTarget`.

The code path, deterministic end-to-end tests, and isolated Liberty Labs live proof are complete. Replacing the ordinary legacy Socket Mode process and soaking the path with the configured real LLM profile remain the operational rollout boundary.

## Remaining product rollout

Proceed incrementally:

1. restart the normal SmolPaws host from the reviewed checkout so it releases the obsolete Slack Socket Mode connection;
2. run standalone `paws` against the TypeScript agent-server and configured real LLM profile, verify durable rows/EventLog, and soak restart/reconciliation behavior;
3. design a rollback-safe canary for the primary WhatsApp path;
4. migrate other bridges only after reviewing their existing behavior and delivery semantics;
5. remove the old `/turns` runner only after every in-use bridge has a clean soak on the new path.

This document records current invariants and boundaries. Historical implementation experiments belong in git history, not here.
