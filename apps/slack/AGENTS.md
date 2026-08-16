# Slack Message Relay

Standalone Socket Mode canary for SmolPaws' durable Message Relay architecture.

## Current architecture

Slack is deliberately greenfield. It does **not** use the legacy `/turns` runner and is not started by the shared bridge loader.

```text
Slack Socket Mode
  -> SlackBridge / slackHandler
  -> SlackRelayRuntime.accept()
  -> MessageRelay durable intake (SQLite)
  -> TypeScript OpenHands agent-server (:8790)
  -> agent EventLog
  -> OutboundRelay.syncDeliveryOutbox()
  -> durable delivery outbox
  -> DeliveryDispatcher
  -> SlackDeliveryTarget
  -> chat.postMessage
```

Run `apps/slack` as its own process. Do not reintroduce `BaseBridgeAdapter`, `bridgeRegistry`, `turnClient`, or `/turns` into this app.

## Naming and ownership

- **Message Relay** is the complete durable external-message subsystem.
- `MessageRelay` owns lane binding, durable intake, agent-server integration, and `syncDeliveryOutbox()`.
- `OutboundRelay` repeatedly catches agent events up into the durable delivery outbox.
- `DeliveryDispatcher` owns the external side-effect boundary.
- `SlackRelayRuntime` runs the intake and outbound workers for Slack.
- `SlackDeliveryTarget` performs Slack-specific `chat.postMessage` calls.

The old `MessageWorkCoordinator`, `CoordinatorOptions`, `SlackCoordinatorRuntime`, and `SlackCoordinatorRuntimeOptions` exports are compatibility aliases only. New code must use the Relay names.

## Slack app versus local code

The installed Slack app contains configuration, not this TypeScript implementation. Slack owns the bot identity, OAuth/app tokens, scopes, event subscriptions, and Socket Mode settings. The executable bridge code lives in this repository and runs on the SmolPaws host.

Internal Relay changes do not require reinstalling the Slack app. Reinstall or reauthorize only when OAuth scopes or event subscriptions change.

## Durable boundaries

Coordinator SQLite, keyed by the stable Slack message identity, is the durable idempotency authority. `MessageDeduplicator` is only a short-lived process-local gate and must never become the source of truth.

The first authoritative Slack relay generation uses:

```text
~/.smolpaws/coordinator/slack-relay-v1.db
conversation namespace: slack-relay:v1
```

Do not point it at the old shadow database or earlier unversioned conversation IDs. Reusing those identities could rediscover historical shadow responses and send them to Slack.

Once a delivery row is durably marked `send_attempted`, an exception is `delivery_unknown`; never blindly repeat an external effect that may already have landed.

## Local canary

Install dependencies:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack
```

Start the TypeScript agent-server:

```bash
./scripts/run-local-smolpaws.sh npm --prefix packages/openhands-agent-server run dev:server
```

It listens on `127.0.0.1:8790` by default. Then start paws separately:

```bash
./scripts/run-local-smolpaws.sh npm --prefix apps/slack run start
```

Preferred environment variables in `~/.smolpaws/.env`:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SMOLPAWS_RELAY_SERVER_URL` (default `http://127.0.0.1:8790`)
- `SMOLPAWS_RELAY_SERVER_API_KEY` when agent-server auth is enabled
- optional Slack team/channel/user allowlists

`SMOLPAWS_COORD_SERVER_URL` and `SMOLPAWS_COORD_SERVER_API_KEY` remain temporary compatibility fallbacks.

The server must have a usable active LLM profile and credential in its state/keychain.

## Tests

```bash
npm run typecheck --prefix apps/slack
npm run test --prefix apps/slack
```

The focused suite proves retryable durable acceptance, duplicate suppression, real SQLite behavior, real TypeScript agent-server execution with a deterministic fake LLM, outbox synchronization, Delivery Dispatcher settlement, and Slack thread routing.

## Liberty Labs canary

The Slack app identity is `paws`. A valid live result requires all of:

1. Slack ingress is accepted.
2. An `intake` row exists in `~/.smolpaws/coordinator/slack-relay-v1.db`.
3. The new agent-server contains the deterministic user event and completed run.
4. `syncDeliveryOutbox()` creates the delivery row.
5. Delivery Dispatcher settles it `done` with the Slack timestamp as `external_message_id`.
6. The reply appears in the correct Slack DM/thread.

A visible Slack reply alone is insufficient. The old `🐾 Done — nothing to report back.` response proves a legacy `/turns` process handled the message.

## Thread follow-ups

Once paws is mentioned in a thread, subsequent replies in that thread are accepted without another mention. The tracker is currently in memory and resets on restart. It is committed only after durable intake acceptance.
