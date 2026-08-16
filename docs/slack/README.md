# Slack Message Relay Architecture

Slack is the first greenfield bridge for SmolPaws' durable Message Relay.

It intentionally does **not** preserve the unused legacy Slack implementation, inherit the shared bridge adapter, or route messages through the old `/turns` runner. Slack runs as its own Socket Mode process beside the upstream-shaped TypeScript agent-server.

## Current flow

```text
Slack Socket Mode
  -> SlackBridge / slackHandler
  -> SlackRelayRuntime.accept()
  -> MessageRelay durable intake in SQLite
  -> TypeScript OpenHands agent-server on :8790
  -> durable agent EventLog
  -> OutboundRelay.syncDeliveryOutbox()
  -> durable delivery outbox
  -> DeliveryDispatcher
  -> SlackDeliveryTarget
  -> chat.postMessage
```

The ingress success boundary is durable acceptance, not an in-memory request finishing. A reply may be produced later after a process delay or restart.

## Names and boundaries

### Message Relay

**Message Relay** is the complete product subsystem around agent-server for durable external messaging.

`MessageRelay` owns:

- canonical lane-to-conversation binding;
- durable and idempotent intake acceptance;
- ordered intake integration into agent-server;
- `syncDeliveryOutbox()`, which catches durable agent events up into delivery work.

`MessageWorkCoordinator` remains only as a compatibility export for code that has not migrated to the preferred name.

### Outbound Relay

`OutboundRelay` runs the outbound half. It repeatedly calls `syncDeliveryOutbox()` for known conversations and asks the Delivery Dispatcher to drain bounded work. It does not know Slack APIs.

### Delivery Dispatcher

`DeliveryDispatcher` owns the external side-effect boundary:

```text
claim
  -> validate target and payload
  -> durably mark send_attempted
  -> call platform DeliveryTarget
  -> settle done / failed / delivery_unknown
```

Validation happens before `send_attempted`. Once sending may have begun, an exception is treated conservatively as `delivery_unknown`; the system does not blindly repeat an effect that may already have reached Slack.

### Slack Relay Runtime

`apps/slack/src/relayRuntime.ts` hosts the Slack workers:

1. durably accept normalized Slack messages;
2. integrate ready intake into the new agent-server with deterministic event IDs;
3. reconcile expired claims and retry waits;
4. synchronize the delivery outbox;
5. dispatch bounded Slack sends.

`SlackCoordinatorRuntime` remains a compatibility export from `coordinatorRuntime.ts` only.

### Slack bridge and delivery target

`SlackBridge` owns Bolt Socket Mode, event subscriptions, bot-loop guards, and Slack API wiring. `SlackDeliveryTarget` translates a durable Slack lane plus payload into `chat.postMessage`, preserves `thread_ts`, splits long messages, and returns Slack's timestamp as the external message ID.

The installed Slack app contains configuration rather than this TypeScript. Slack stores bot identity, OAuth/app tokens, scopes, event subscriptions, and Socket Mode settings. The executable bridge runs from this repository on the SmolPaws host.

Changing internal Relay code or the local agent-server URL does not require reinstalling the Slack app. Reauthorization is needed only when scopes or event subscriptions change.

## Identity and idempotency

A Slack event uses the stable source identity:

```text
{channel_id}:{message_ts}
```

The Message Relay combines it with the workspace and derives a deterministic agent event ID. Replays therefore converge on the existing intake row and agent event.

A Slack conversation maps to one durable lane:

```text
channel:slack:{team_id}:{channel_id}:{thread_ts-or-root}
```

The first authoritative generation uses:

```text
~/.smolpaws/coordinator/slack-relay-v1.db
conversation namespace: slack-relay:v1
```

Both identities are separate from earlier shadow experiments, preventing first catch-up from rediscovering and sending historical shadow responses.

## Outbound policy

The first Slack canary delivers the normal terminal `finish` observation. Ordinary chat does not require the agent to call a Slack-specific `send_message` tool.

The extractor remains replaceable. Explicit outbound-intent events can later support richer multi-message behavior without changing the durable dispatcher.

## Configuration

Preferred local configuration in `~/.smolpaws/.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SMOLPAWS_RELAY_SERVER_URL=http://127.0.0.1:8790
SMOLPAWS_RELAY_SERVER_API_KEY=...

# Optional policy
SLACK_ALLOWED_TEAM_IDS=T12345
SLACK_ALLOWED_CHANNEL_IDS=C12345,D12345
SLACK_ALLOWED_USER_IDS=U12345
```

The old `SMOLPAWS_COORD_SERVER_*` names remain temporary fallbacks. Raw provider credentials do not belong in Relay SQLite or delivery rows; the agent-server resolves its active profile credential through its own state/keychain.

## Running the canary

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack

./scripts/run-local-smolpaws.sh npm --prefix packages/openhands-agent-server run dev:server
./scripts/run-local-smolpaws.sh npm --prefix apps/slack run start
```

The new server listens on `127.0.0.1:8790` by default. Do not rely on the old `apps/agent-server` process to host Slack.

## Verification

The focused Slack workflow runs typechecking plus the Slack and Relay tests. It covers durable lane derivation, outbox replay, successful and ambiguous delivery settlement, retryable acceptance, concurrent duplicate suppression, and a deterministic end-to-end run through the real TypeScript agent-server, fake LLM, SQLite, Outbound Relay, Delivery Dispatcher, and Slack Delivery Target.

A live canary requires evidence from every boundary:

1. Slack event accepted;
2. intake row present in `~/.smolpaws/coordinator/slack-relay-v1.db`;
3. deterministic user event and completed run present in the new agent-server;
4. delivery row created by `syncDeliveryOutbox()`;
5. delivery settled `done` with Slack's timestamp;
6. reply visible in the correct thread or DM.

A visible reply alone is not proof. In particular, `🐾 Done — nothing to report back.` is the old `/turns` fallback and proves the Message Relay did not handle that message.

## Rollout boundary

Slack is the non-critical canary. WhatsApp, Discord, and other bridges remain unchanged until their real usage and platform semantics are reviewed separately.
