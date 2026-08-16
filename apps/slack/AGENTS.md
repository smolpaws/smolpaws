# Slack App

Standalone Socket Mode canary for the durable SmolPaws message-work architecture.

## Current architecture

Slack is deliberately greenfield. It does **not** use the legacy `/turns` runner and is not started by the shared bridge loader.

```text
Slack Socket Mode
  -> SlackBridge / slackHandler
  -> SlackCoordinatorRuntime.accept()
  -> coordinator durable intake (SQLite)
  -> TypeScript OpenHands agent-server (:8790)
  -> agent EventLog
  -> OutboundRelay.syncDeliveryOutbox()
  -> durable delivery outbox
  -> DeliveryDispatcher
  -> SlackDeliveryTarget
  -> chat.postMessage
```

Run `apps/slack` as its own process. Do not reintroduce `BaseBridgeAdapter`, `bridgeRegistry`, `turnClient`, or `/turns` into this app.

## Ownership

- `adapter.ts`: standalone Bolt/Socket Mode lifecycle and Slack API wiring.
- `slackHandler.ts`: Slack ingress policy, normalization, access control, thread context, and the short-lived in-process event gate.
- `coordinatorRuntime.ts`: Slack-hosted coordinator workers; durable SQLite acceptance is the ingress success boundary.
- `src/coordinator/outboundRelay.ts`: catches durable agent events up into the delivery outbox through `syncDeliveryOutbox()`.
- `src/coordinator/deliveryDispatcher.ts`: claims delivery work, marks the external-send fence, invokes the target, and settles the durable outcome.
- `deliveryTarget.ts`: Slack-specific `chat.postMessage` side effect using the lane's durable channel/thread coordinates.
- `packages/openhands-agent-server`: source of truth for conversation events and agent execution.

## Idempotency rule

Coordinator SQLite, keyed by the stable Slack message identity, is the durable idempotency authority.

`MessageDeduplicator` is only a short-lived process-local gate. It reserves an event while acceptance is in flight, commits it after durable acceptance, and releases it on failure so a Slack retry can try again. Never move the durable boundary back into RAM.

## Delivery rule

The canary synchronizes the normal terminal `finish` observation into the Slack delivery outbox. Slack does not require an agent-specific `send_message` tool merely to produce a normal chat response.

Once a delivery row has been durably marked `send_attempted`, an exception is treated as `delivery_unknown`; the dispatcher does not blindly retry an external effect that may already have landed.

During shutdown, stop Socket Mode ingress first but keep the Slack Web API client alive until the active coordinator tick drains. Otherwise a delivery already past its send fence could be turned into a false `delivery_unknown` merely because the process was stopping.

## Canary identity

The first authoritative Slack relay generation deliberately uses:

```text
~/.smolpaws/coordinator/slack-relay-v1.db
conversation namespace: slack-relay:v1
```

Do not point it at the old `shadow.db` or the earlier unversioned conversation IDs. Reusing those identities could make the first outbox catch-up rediscover historical shadow responses and send them to Slack.

## Local canary

Install the root, new agent-server package, and Slack dependencies:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack
```

Before the first canary after pulling this architecture, restart the normal SmolPaws host once. On the current checkout `apps/slack/plugin.json` is `kind: "standalone"`, so the shared bridge loader no longer opens a Slack Socket Mode connection. A stale host may otherwise race the new process and answer through `/turns`.

Then use the one-command launcher:

```bash
npm run slack:relay:local
```

It loads `~/.smolpaws/.env`, exports the current git SHA into the Slack startup log, reuses an already-healthy server at `SMOLPAWS_COORD_SERVER_URL`, or starts the default TypeScript server on `127.0.0.1:8790`, and then runs standalone paws. It stops only the server process it started itself.

For separate-process debugging, start the TypeScript agent-server manually:

```bash
./scripts/run-local-smolpaws.sh npm --prefix packages/openhands-agent-server run dev:server
```

Then start paws:

```bash
./scripts/run-local-smolpaws.sh npm --prefix apps/slack run start
```

Relevant environment variables in `~/.smolpaws/.env`:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SMOLPAWS_COORD_SERVER_URL` (default `http://127.0.0.1:8790`)
- `SMOLPAWS_COORD_SERVER_API_KEY` when agent-server auth is enabled
- optional Slack team/channel/user allowlists

The new server must also have a usable active LLM profile/credential in its server state/keychain.

## Tests

```bash
npm run typecheck --prefix apps/slack
npm run test --prefix apps/slack
```

The focused suite includes:

- red/green coverage proving a failed durable acceptance can be retried;
- concurrent duplicate suppression while acceptance is in flight;
- deterministic end-to-end delivery through the real in-process TypeScript agent-server, fake LLM `finish`, real SQLite, Outbound Relay, Delivery Dispatcher, and Slack Delivery Target.

The `slack-coordinator` CI job also syntax-checks `scripts/run-local-slack-relay.sh` and runs the coordinator's real-server integration suite.

## Liberty Labs canary

The Slack app identity is `paws`. Use the Liberty Labs workspace as the non-critical live canary. Verify one message by checking all of:

1. the Slack startup log identifies the intended git SHA;
2. the Slack ingress event is accepted;
3. an `intake` row exists in `~/.smolpaws/coordinator/slack-relay-v1.db`;
4. the new agent-server contains the deterministic user event and a completed agent run;
5. `syncDeliveryOutbox()` creates the corresponding `delivery` row;
6. Delivery Dispatcher settles it `done` with the Slack message timestamp as `external_message_id`;
7. the reply appears in the correct Slack DM/thread.

Do not infer success merely because Slack shows a reply; the durable work rows and new agent-server EventLog are part of the end-to-end contract.

A reply containing the old `🐾 Done — nothing to report back.` fallback proves an older `/turns` process is still running. It is not a successful Relay canary.

## Thread follow-ups

Once paws is mentioned in a thread, subsequent replies in that thread are accepted without another mention. The tracker is currently in-memory and resets on process restart. It is committed only after durable intake acceptance.
