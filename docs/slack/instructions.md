# Slack Coordinator Canary Operations

These instructions run the real `paws` Slack app through the durable coordinator path and the TypeScript OpenHands agent-server.

Slack is greenfield. It does not use the legacy SmolPaws `/turns` server on port 8788, and the shared bridge loader does not start it.

## Prerequisites

- Node.js 20 or newer;
- the repository checked out locally;
- the `paws` Slack app installed in the target workspace;
- Socket Mode enabled;
- a bot token and app-level Socket Mode token;
- a usable LLM profile and provider credential available to the TypeScript agent-server.

## Slack app configuration

### Bot token scopes

- `app_mentions:read`
- `chat:write`
- `im:history`
- `reactions:write`
- `channels:history` when channel-thread follow-ups/context are enabled

Private-channel support additionally requires the corresponding private-channel scopes and an explicit decision to enable it.

### Event subscriptions

- `app_mention`
- `message.im`
- `message.channels` when channel-thread follow-ups are enabled

Socket Mode means no public request URL or tunnel is required.

## Install dependencies

From the repository root:

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/slack
```

## Environment

Put local values in `~/.smolpaws/.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# New upstream-shaped TypeScript server
SMOLPAWS_COORD_SERVER_URL=http://127.0.0.1:8790

# Set only when the server requires session auth
SMOLPAWS_COORD_SERVER_API_KEY=...

# Optional allowlists
SLACK_ALLOWED_TEAM_IDS=T12345
SLACK_ALLOWED_CHANNEL_IDS=C12345,D12345
SLACK_ALLOWED_USER_IDS=U12345
```

Never commit token values. Coordinator SQLite contains message/work metadata only, never provider or Slack credentials.

The first authoritative Slack Relay generation uses:

```text
coordinator database: ~/.smolpaws/coordinator/slack-relay-v1.db
conversation namespace: slack-relay:v1
```

Those identities are deliberately separate from the old shadow experiment. Do not rename the old shadow database into this path or reuse its lane bindings, because the first outbox catch-up could rediscover historical shadow responses and send them to Slack.

## First cutover from the old local host

The old running SmolPaws host may still have loaded the earlier Slack bridge even after the repository was updated. Before the first canary:

1. pull the intended `enyst/smolpaws` commit;
2. rebuild/restart the normal SmolPaws host once;
3. confirm that current `apps/slack/plugin.json` says `kind: "standalone"`;
4. then start the standalone Relay process.

Restarting the normal host does not migrate WhatsApp, Discord, or other bridges. It only makes the current shared loader stop opening the obsolete Slack Socket Mode connection.

## One-command local canary

```bash
npm run slack:relay:local
```

The launcher:

- loads `~/.smolpaws/.env`;
- exports the current git SHA as `SMOLPAWS_BUILD_SHA`, which appears in the Slack startup log;
- reuses an already-healthy server at `SMOLPAWS_COORD_SERVER_URL`;
- otherwise starts the default TypeScript server on `127.0.0.1:8790`;
- starts standalone paws;
- stops only the server process that it started itself.

For a non-default server URL, start that server separately before invoking the launcher.

## Separate-process debugging

Start the TypeScript agent-server:

```bash
./scripts/run-local-smolpaws.sh \
  npm --prefix packages/openhands-agent-server run dev:server
```

Defaults:

```text
host: 127.0.0.1
port: 8790
```

Verify it:

```bash
curl -fsS http://127.0.0.1:8790/health
```

Then start paws in another terminal:

```bash
SMOLPAWS_BUILD_SHA="$(git rev-parse HEAD)" \
  ./scripts/run-local-smolpaws.sh npm --prefix apps/slack run start
```

The startup log must say the bot is ready on the coordinator path and show the intended build SHA and agent-server URL.

## Focused checks

```bash
npm run coordinator:test
npm run typecheck --prefix apps/slack
npm run test --prefix apps/slack
bash -n scripts/run-local-slack-relay.sh
```

The dedicated GitHub Actions job is named `slack-coordinator`. It provides an honest signal for this canary even while unrelated agent-server OpenAPI parity debt may keep the repository-wide `checks` job red.

## Live test procedure

Use a non-critical channel in the Liberty Labs workspace.

1. Start the new server and standalone paws from the intended checkout.
2. Confirm the startup log identifies the expected SHA.
3. Mention `paws` with a unique response token.
4. Confirm paws replies in the correct Slack thread exactly once.
5. Confirm coordinator intake and delivery evidence exists.
6. Confirm the new server EventLog contains the deterministic user event and terminal agent output.

The source key for a Slack event is:

```text
slack:{team_id}:{channel_id}:{message_ts}
```

Useful read-only SQLite inspection with the root dependency installation:

```bash
node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const db = new Database(
  path.join(os.homedir(), '.smolpaws/coordinator/slack-relay-v1.db'),
  { readonly: true },
);

console.log('lanes');
console.table(db.prepare(`
  SELECT lane_key, conversation_id, conversation_ready, last_seen_at
  FROM lanes
  WHERE platform = 'slack'
  ORDER BY last_seen_at DESC
  LIMIT 10
`).all());

console.log('work');
console.table(db.prepare(`
  SELECT kind, source_key, state, conversation_id, agent_event_id,
         send_attempted, external_message_id, last_error, updated_at
  FROM work
  WHERE lane_key LIKE 'channel:slack:%'
  ORDER BY updated_at DESC
  LIMIT 20
`).all());
NODE
```

For one canary, verify:

- the `intake` row reaches `done`;
- its `conversation_id` exists in the server;
- `syncDeliveryOutbox()` creates a corresponding `delivery` row;
- the delivery reaches `done`;
- `send_attempted` is true;
- `external_message_id` contains the Slack message timestamp.

If a delivery reaches `delivery_unknown`, do not manually make it ready and retry until Slack has been checked. The original send may already have succeeded.

## Restart and shutdown behavior

Coordinator state survives process restarts. On startup, the runtime:

- reconciles expired intake claims that are safe to retry;
- preserves ambiguous delivery sends as `delivery_unknown`;
- resumes event-to-outbox catch-up from durable cursors;
- dispatches already-durable delivery rows in lane order.

On shutdown, Socket Mode ingress stops first, but the Slack Web API client remains available while the active Relay tick drains. This lets an already-claimed delivery complete rather than manufacturing an ambiguous-send state during an orderly stop.

The in-memory mentioned-thread tracker does not survive restart. After a restart, mention paws once in an existing channel thread before relying on mention-free follow-ups there.

## Troubleshooting

### Paws replies through the wrong architecture

A reply containing:

```text
🐾 Done — nothing to report back.
```

proves that an older process is still using `BaseBridgeAdapter` and `/turns`. It is not a Relay canary result. Restart the normal SmolPaws host from the current checkout so it releases the obsolete Slack connection, then restart standalone paws.

### Paws replies twice

Two Socket Mode processes probably consumed the same app stream. Stop the standalone process, restart the normal host from current code, then start only `npm run slack:relay:local` for Slack.

### Port 8790 is unavailable

Start `packages/openhands-agent-server` with `dev:server` and inspect its logs. Do not silently redirect Slack back to port 8788.

### Intake is present but no delivery appears

Check the agent-server EventLog and confirm the run produced either a terminal `finish` observation or an agent `MessageEvent`. The Slack extractor supports both normal reply shapes.

### Delivery is `delivery_unknown`

Inspect the Slack thread for the expected message and reconcile deliberately. Automatic blind retry is intentionally disabled after an external send may have begun.
