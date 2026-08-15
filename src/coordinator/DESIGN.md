# Message Work Coordinator — Current Design

The coordinator is SmolPaws-owned infrastructure around the upstream-shaped OpenHands agent-server. It is **not** part of the Python→TypeScript transpilation and should not be judged by source parity.

Its job is to make external message intake and delivery durable without pushing queue semantics into `packages/openhands-agent-server`.

## Ownership

- **Agent-server EventLog:** source of truth for conversations, events, and agent execution state.
- **Coordinator SQLite store:** source of truth for external work: intake deduplication, lane→conversation mapping, ordering, claims, retries/backoff, delivery outcomes, projection cursors, and audit state.
- **Channel adapter:** canonical lane identity, platform formatting, actual platform send, and platform-specific reconciliation when available.

One fact should have one owner. The coordinator must not duplicate the agent-server execution state machine.

## Integration target

The coordinator talks to `packages/openhands-agent-server` through the narrow `AgentServerClient` interface. The old `apps/agent-server` `/turns` runner is migration/reference code, not the target architecture.

The current agent-server extension `EXT-SERVER-001` allows an optional deterministic caller-supplied `event_id` on `POST /events`. This closes the intake append-response-loss window without moving queue behavior into agent-server.

## Durable model

The SQLite store keeps:

- a persisted `lanes` directory mapping a canonical external lane to one agent-server conversation;
- a unified `work` table for `intake` and `delivery` rows;
- monotonically increasing per-lane/per-kind sequence numbers;
- state, availability time, claim owner/expiry, generation fence, attempts, send-attempt fence, errors, external message IDs, and immutable payloads;
- per-conversation delivery projection cursors.

## Intake invariant

A platform message has a stable `source_key` and deterministic agent event ID.

Flow:

```text
adapter input
  -> resolve/ensure lane conversation
  -> accept durable intake row (idempotent)
  -> claim lane head
  -> append deterministic user event with run=true
  -> settle done/retry/failed
```

If the append succeeds but the response is lost, retrying the same deterministic `event_id` is safe: agent-server returns the existing event instead of creating another user turn.

## Delivery invariant

Delivery work is projected from durable agent events, not invented as ephemeral bridge state.

Only the unresolved lane head is claimable, so later work cannot silently overtake earlier work in the same lane/kind.

A delivery worker must durably mark `send_attempted` immediately before invoking the external platform:

- expired claim with `send_attempted = 0` → safe to make ready again;
- expired claim with `send_attempted = 1` → `delivery_unknown`; never blindly retry an external effect that may already have happened.

`delivery_unknown` blocks later delivery in the lane until reconciled or explicitly resolved.

## Claim and retry invariant

Claims are fenced by generation plus claim expiry. Stale workers cannot settle work after another worker has reclaimed it.

Retryable failures use durable backoff and eventually become `failed` after the configured attempt budget. Non-retryable failures fail directly.

## Projection invariant

`projectDeliveries(conversationId)` reads durable agent events in pages and inserts delivery work with a unique source identity based on agent event + destination lane.

Delivery rows are inserted before the projection cursor advances. If the process crashes between those operations, replay is safe because the unique work identity makes re-insertion a no-op.

The default extractor currently projects explicit outbound-intent action events (`send_message` / `current_thread_message`). Alternative extractors, including terminal/final-response projection, remain an explicit policy seam rather than hidden behavior.

## Testing

The coordinator core is covered with deterministic real-SQLite tests for:

- duplicate intake acceptance;
- lane persistence/concurrent resolution;
- head-of-line ordering;
- fenced claims and claim expiry;
- retries/backoff/exhaustion;
- `delivery_unknown` versus safe retry;
- operator resolution paths;
- projector replay/pagination/cursor behavior.

There is also an integration test against the real in-process `@smolpaws/openhands-agent-server` proving deterministic `event_id` append and replay without duplicate user events.

## Rollout status and remaining product work

The durable coordinator core and real agent-server intake integration exist. Bridge adoption is the remaining product rollout boundary.

Proceed incrementally:

1. shadow/intake path on a non-critical bridge;
2. recording-only delivery projection;
3. canary the primary WhatsApp path with rollback;
4. migrate the remaining bridges onto the same coordinator interface;
5. remove the old `/turns` runner only after a clean soak on the new path.

This section may be updated as rollout progresses. Historical implementation experiments do not belong here; git history already preserves them.
