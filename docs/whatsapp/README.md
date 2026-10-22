# WhatsApp Message Relay bridge

`apps/whatsapp` is the standalone WhatsApp bridge for SmolPaws' durable Message Relay. It is the
primary channel between the cat and its human, rebuilt in the shape `apps/slack` proved (bead
`smolpaws-kxa`, epic `smolpaws-zlo`): its own process, the shared Message Relay, the TypeScript
OpenHands agent-server on `:8790`, no `/turns`.

The legacy root process (`src/index.ts`, `npm start`) remains reference and rollback code. Normal
operation uses the standalone bridge. Run only one WhatsApp bridge for a given account.

## Deployment status

Since the verified September 17 promotion, `com.smolpaws.bridge.whatsapp` uses the shared product host
`com.smolpaws.relay-server` on `:8790`, retaining the conversations and scheduled work from the canary.
The old canary services on `:8791` and legacy `com.smolpaws` remain disabled. See the
[dated promotion record](READINESS.md#september-17-production-promotion) for preservation counts and
startup evidence; it does not claim a new user-confirmed reply after the move.

Current TypeScript conversations live in `~/.smolpaws/conversations/<uuid>/events/`. The older Main
transcripts remain separately at `~/.openhands/conversations/main-*/events.jsonl`. The WhatsApp auth
and ledger remain under `~/.smolpaws/whatsapp/`; promotion does not recreate the device link or Main
conversation. Normal relay/scheduler state is under `~/.smolpaws/coordinator/`.

Before starting on an existing WhatsApp account, follow [Readiness and cutover gates](READINESS.md).
The bridge imports the actual legacy `data/router_state.json` once into its shared message-identity journal.
A fresh relay database alone does not isolate reused server conversations. The setup below describes
configuration; follow the dated migration and rollback procedure when transferring an existing account.

## Flow

```text
WhatsApp (Baileys socket)
  -> ledger: ~/.smolpaws/whatsapp/messages.db (chats, messages, media, cursors)
     cursors are the ledger's own ingestion sequence (`messages.seq`), never WhatsApp's one-second timestamps,
     so two messages in the same second or a late offline-sync message are never skipped
  -> poll every 2s, one batch per registered chat, debounced
  -> WhatsAppBridge.pollChat: scope + trigger policy, <messages> transcript
  -> RelayRuntime.accept()             durable intake (~/.smolpaws/coordinator/whatsapp-relay-v1.db)
  -> TypeScript OpenHands agent-server (:8790), one conversation per chat lane
  -> agent EventLog
  -> syncDeliveryOutbox()              send_message actions + terminal response
  -> DeliveryDispatcher -> WhatsAppDeliveryTarget -> sock.sendMessage
```

Identity:

- lane: `whatsapp:{account}:{chat_jid}`, one agent-server conversation per registered chat;
- conversation id: the existing relay binding is authoritative; a new lane defaults to a deterministic id derived from its key (legacy `data/sessions.json` ids are never reused);
- intake source key: `whatsapp:{account}:{newest WhatsApp message id in the batch}`;
- delivery source key: `{agent event id}:{lane}`.

Outbound text is prefixed `smolpaws: ` exactly as before, because the human shares the account and the
ledger recognizes the cat's own messages by that prefix.

## What moved where

| Legacy (`src/`) | Bridge (`apps/whatsapp/src/`) |
|---|---|
| `index.ts` connect/reconnect/QR exit | `adapter.ts` `WhatsAppBridge.connect()` |
| `index.ts` `messages.upsert` + media download | `adapter.ts` `ingest()` |
| `startMessageLoop` + `message-loop.ts` | `adapter.ts` `pollOnce()` / `pollChat()` (per-chat progress; durable local intake and bounded HTTP requests) |
| `processMessage` transcript + images/docs | `handler.ts` `buildPrompt()` |
| `control-scope.ts` / `config.ts` trigger | `handler.ts` `shouldRespond()` + `config.ts` |
| `db.ts` chats/messages | `ledger.ts` (same schema, plus `relay_state` cursors) |
| `data/router_state.json` | One-time import into the shared message-identity progress journal in `messages.db` |
| `data/registered_groups.json` | `~/.smolpaws/whatsapp/registered_groups.json` (legacy path still read) |
| `sendMessage` + `whatsapp-jid.ts` rewrite | `deliveryTarget.ts` + `adapter.ts` `sendText()` |
| `whatsapp-auth.ts` | `auth.ts` (QR or pairing code) |
| `task-scheduler.ts` | Shared `src/coordinator/taskScheduler.ts`; see "Scheduler, media and rollback" below |
| voice outbox drain | `voiceOutbox.ts` imports the established producer into durable media delivery |

Each chat's agent conversation works in `groups/<scope>` under the checkout, as before. The
SmolPaws product server loads identity and private memory from its [context configuration](../context-files.md).
Select private memory explicitly for each authorized scope (for example `whatsapp:main` or
`whatsapp:openhands`). The full selected files are always-on SDK context, captured once beside each
conversation. No read-before-answer tool step or larger launch-suffix limit is needed.

Choose each chat's LLM profile in the shared [model configuration](../models.md), using scope keys
such as `whatsapp:main`. A changed selection applies to the existing conversation at a safe boundary;
the agent's `switch_llm` tool uses that same activation path. The bridge keeps no separate profile map.

## Typing indicator

The bridge briefly sends composing presence while accepting an incoming message into the durable
relay, then clears it. This indicates message intake only, not the duration of the agent turn.
The bridge does not poll conversation execution status to maintain typing presence.

## Errors and follow-up messages

The bridge also sends `smolpaws: 🐾 I'm up.` to every registered chat after startup. It does not
repeat that notice on ordinary socket reconnects or invoke the LLM. Set
`SMOLPAWS_WHATSAPP_STARTUP_PING=0` only when intentionally suppressing these notices, for example
during a silent test. See [shared startup notice behavior](../bridges.md#startup-notices).

A conversation-level error produces a short WhatsApp notice. Step-limit notices identify the limit;
other errors use a generic message without exposing raw provider details. Send a follow-up prompt to
continue the same conversation with its saved context and a fresh run allowance. The normal limit is
500 steps per run. See [conversation failure delivery](../bridges.md#conversation-failures-and-continuation)
for the shared outbox and configuration rules.

## Setup

### 1. Dependencies

```bash
npm ci
npm ci --prefix packages/openhands-agent-server
npm ci --prefix apps/whatsapp
```

### 2. Link the device

WhatsApp links a "device" to your phone's account. Credentials go to
`~/.smolpaws/whatsapp/auth/` and stay valid for weeks; the bridge refuses to pair inline and exits
with a macOS notification when a new link is needed.

QR code:

```bash
npm run whatsapp:auth
```

Pairing code (no camera needed; use the phone number of the WhatsApp account, international format):

```bash
npm run whatsapp:auth -- --phone +15551234567
```

Then on the phone: Settings → Linked Devices → Link a Device → scan, or "Link with phone number
instead" and type the code. To re-link, delete `~/.smolpaws/whatsapp/auth/` and run again.

An existing link from the legacy root process is reused as-is; nothing to redo.

### 3. Register chats

The bridge selects one registration file at startup, in this order:

1. `SMOLPAWS_WHATSAPP_REGISTERED_GROUPS`, when set;
2. `<SMOLPAWS_HOME_DIR>/whatsapp/registered_groups.json`, when present (`SMOLPAWS_HOME_DIR` defaults to `~/.smolpaws`);
3. the legacy checkout's `data/registered_groups.json`, when present.

These files are **not merged**. An explicit canary file replaces the normal list for that process;
editing a fallback file does not change the running canary's chats. If no file exists, the bridge
starts with no registered chats. Each key is a WhatsApp chat JID:

```json
{
  "1234567890@s.whatsapp.net": { "name": "Engel", "folder": "main", "trigger": "@smolpaws", "added_at": "2026-01-01T00:00:00Z" },
  "120363012345678@g.us":     { "name": "Team",  "folder": "team", "trigger": "@smolpaws", "added_at": "2026-01-01T00:00:00Z", "triggerFree": false }
}
```

Add another entry to the selected file to enable another chat; preserve its existing `folder` when
migrating a legacy group. `folder` selects the scope and `groups/<folder>` workspace. Only `main` is
the control scope. `triggerFree: true` lets another group answer ordinary text without granting
control-scope permissions. Otherwise, messages need an `@<ASSISTANT_NAME>` mention (normally
`@smolpaws`). The stored `trigger` field is retained for legacy compatibility; the current matcher
uses `ASSISTANT_NAME`, not a separate trigger per entry.

The selected file is re-read when its modification time changes, during ingestion and the two-second
poll loop. Adding a chat or changing `triggerFree` applies to subsequent human-message handling
without a restart. Changing the environment variable to select a different file requires restarting
the process. This reload does not recreate existing conversations: workspace/context and the server's
default profile are resolved when a conversation is first created. There is no per-chat model field.

Registration is checked before message content is stored. An excluded chat updates chat metadata only;
its new text/media is not saved for later recovery. A registered but unmentioned message is retained
as context for a later addressed message. Enabling a chat does not recover messages dropped while it
was excluded, and any already-pending ledger rows should be accounted for before expanding a canary.

### 4. Environment

`~/.smolpaws/.env` (loaded by every launcher):

```bash
SMOLPAWS_RELAY_SERVER_URL=http://127.0.0.1:8790     # default
SMOLPAWS_RELAY_SERVER_API_KEY=...                   # only if the server enforces X-Session-API-Key
ASSISTANT_NAME=smolpaws                             # default
SMOLPAWS_WHATSAPP_REGISTERED_GROUPS=/absolute/path/to/registered_groups.json  # optional override
```

The agent-server needs an active LLM profile and credential in its own state/keychain; legacy
`LLM_PROFILE_ID` does not select it. WhatsApp uses `groups/<folder>` for each chat's workspace,
overriding the shared bridge `SMOLPAWS_WORKING_DIR` default.

### 5. Run

Foreground (starts the agent-server on `:8790` if nothing healthy answers there, then the bridge):

```bash
npm run whatsapp:start
```

Supervised by launchd (macOS): install once, it survives reboots and restarts the bridge if it dies. The
agent-server it starts is left running for the other bridges.

```bash
npm run bridge:launchagent:install -- whatsapp
npm run bridge:launchagent:remove -- whatsapp
```

Logs: `~/.smolpaws/logs/bridge.whatsapp.launchagent.log` and
`~/.smolpaws/logs/openhands-agent-server-8790.log`.

Before the first start on a host that still runs the legacy root process, stop that LaunchAgent
(`npm run smolpaws:launchagent:remove`) or you get two clients on one account and duplicate replies.

## Verification (six-point canary)

A visible reply alone is not proof. Check every boundary:

1. the ledger has the inbound row: `sqlite3 ~/.smolpaws/whatsapp/messages.db "select id, chat_jid, content from messages order by timestamp desc limit 5"`;
2. an `intake` row reached `done` in `~/.smolpaws/coordinator/whatsapp-relay-v1.db`;
3. the agent-server has the conversation (`GET /api/conversations/{id}`) with the user event and a finished run;
4. `delivery` rows exist for the `send_message` action(s) and/or the terminal response;
5. each delivery is `done` with `send_attempted = 1` and a WhatsApp message id in `external_message_id`;
6. the reply appears in the right chat with the `smolpaws: ` prefix.

```bash
sqlite3 ~/.smolpaws/coordinator/whatsapp-relay-v1.db \
  "select kind, state, send_attempted, external_message_id, last_error from work order by updated_at desc limit 10"
```

`delivery_unknown` means the send may have landed; look at the chat before doing anything.

## Tests

```bash
npm run whatsapp:typecheck
npm run whatsapp:test
```

Inbound images use the SDK content shape, `{ "type": "image", "image_urls": ["data:..."] }`.
The SDK converts this to each provider's wire format. OpenAI-style `image_url` blocks are not
accepted by the agent-server; sending them fails intake and holds later messages in that lane.
The image contract test sends actual `buildPrompt()` output through the server's HTTP route
and verifies the saved text and image bytes, without calling a model.

The suite covers the trigger/scope policy, transcript building with images and documents, ledger
cursors, delivery chunking, and an end-to-end run through a fake Baileys socket, the real in-process
TypeScript agent-server with a deterministic test LLM, the durable relay store, and the delivery
target (both a mid-turn `send_message` and the final reply, exactly once, idempotent on replay).

## Scheduler, media and rollback

The [shared product host](../bridges.md#shared-scheduler-and-media-tools) binds the task tools to the
shared scheduler. Due tasks use the same relay intake as chat messages; all lifecycle commands return
real results. Outbound media and voice notes, including the existing `voice-outbox.jsonl` producer,
use a durable local spool and the normal delivery dispatcher.

Both updated host generations share message-identity progress. After draining and stopping the bridge,
run `npm run whatsapp:handoff -- legacy` before starting the updated legacy host. The command checks
in-flight work and exports scheduler changes; a simple service swap is insufficient. Always use the
latest production state, including changes since promotion; a frozen canary backup would lose that
progress and can replay effects. Follow the full
[readiness and rollback checklist](READINESS.md), including state isolation and the live test gates.
