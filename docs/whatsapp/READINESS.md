# WhatsApp readiness: implementation complete, live preflight next

Updated 2026-09-14. The standalone bridge now includes the history handoff (`kxa.6`), shared scheduler
(`kxa.4`), outbound media/voice (`kxa.2`), existing scope rules (`kxa.8`), recovery (`kxa.9`) and bounded
HTTP intake (`39y`). SDK #30 is merged at `573ec5d`; its reproducibly vendored package also includes
provider fix #28. Beads owns completion and deployment status.

No live WhatsApp send, provider call or service swap was performed for this implementation. The
remaining gates are real-provider preflight (`kxa.7`), one-chat canary (`kxa.5`) and production soak.
See [shared design](../bridges.md) and [architecture page](https://enyst.github.io/arch/whatsapp-readiness.html).

## Implemented and tested

| Capability | Behavior and evidence |
|---|---|
| History | Import the actual legacy `data/router_state.json` once into per-message identity progress in the ledger. Preserve pending, same-second and late arrivals; duplicate inserts cannot reset progress. Both updated host generations use that journal. `historyHandoff.test.ts`. |
| Isolation | One process lock per auth directory; explicit ledger/relay/allowlist paths; startup-ping control; refuse persisted lanes outside the allowlist. A persisted relay owner tag rejects adoption of an unrelated server EventLog. `historyHandoff.test.ts`, HTTP tests. |
| Scheduler | One shared SQLite store, real task-tool observations, scoped lifecycle commands, cron/interval/once, group/isolated runs and idempotent synthetic intake. Real profile/server tests across WhatsApp, Slack, Discord and direct API conversations. |
| Media | Immutable local spool and durable delivery rows; image/video/audio/document delivery. WhatsApp OGG/Opus PTT and the existing private `voice-outbox.jsonl` producer are supported. Outbound IDs suppress media echoes on the shared account. File and symlink scope checks; fake transport tests. |
| Scope | WhatsApp `groups/<folder>` and existing control semantics: `main` can manage tasks across scopes; other scopes see/manage their own. Private durable memory is appended only to WhatsApp control context. No new sandbox or delegation model. |
| Recovery | Durable acceptance requires no server request. HTTP deadlines include response bodies; interrupted tool outcomes are parked; disconnected delivery waits; timed-out sends stay `delivery_unknown`; reconnect creation retries; one shared child supervisor restarts the server. |

The deterministic tests use fake platform transports and a test LLM with the real TypeScript
server/agent. They prove the local path, not provider availability or live media playback.

## Before the first live test — kxa.7

1. Build and start the **SmolPaws product host** (`npm run relay-server:start`) from the reviewed checkout.
   It composes `packages/openhands-agent-server` with product tools; the bare package CLI intentionally
   has no scheduler/media executors. The bridge launcher checks `X-SmolPaws-Host: relay` and starts a
   supervised product host on loopback when absent. Verify the revision and explicit state paths.
2. Inspect the server's active LLM profile and credential availability without exposing values. Legacy
   `LLM_PROFILE_ID` does not select this profile. Do not silently choose another model. Run an internal
   real-provider tool call and continuation before opening the WhatsApp socket.
3. Stop/drain the legacy host. The already-running pre-change binary has no process lock; deploying
   the new lock does not retroactively stop that socket. Back up private ledger, router JSON, relay,
   scheduler and server state while stopped. The updated legacy host is the supported rollback target.
4. Use an explicit registered-chats file containing only the trusted control chat. Set
   `SMOLPAWS_WHATSAPP_REGISTERED_GROUPS`, `SMOLPAWS_WHATSAPP_ROUTER_STATE`, `SMOLPAWS_RELAY_DB_PATH`,
   `SMOLPAWS_SCHEDULER_DB_PATH`, server persistence/state and `SMOLPAWS_WHATSAPP_STARTUP_PING=0`.
   `SMOLPAWS_HOME_DIR` now relocates the default relay path as well as WhatsApp state.
5. Account for scheduled work and queued voice files in that test window. A canary allowlist excludes
   other chats, but tasks for its allowed chat can still become due. Pause them if the test excludes
   scheduled sends. Keep the existing `groups/main` workspace and intended context.

A fresh relay filename alone cannot isolate an existing server conversation. Use separate server
persistence for an isolated canary or reconcile the original relay store; owner mismatch fails closed.

## Controlled one-chat canary — kxa.5

Use a bounded, authorized live-send window. Trace a unique input through all six boundaries:

1. Inbound row in the WhatsApp ledger.
2. Durable intake reaches `done`.
3. Expected server conversation contains the user event and completed run.
4. Expected mid-turn/final delivery rows exist.
5. Delivery is `done`, with `send_attempted=1` and an external WhatsApp message ID.
6. One correctly prefixed reply appears in the intended chat.

Then test a scheduled reply, attachment and playable voice note, duplicate input, queued outbound
restart, and reconnection. Live Slack uploads additionally require `files:write`; Discord needs
attachment permission in the destination channel. Do not treat a text reply as media proof.

## Rollback and re-cutover

Drain the active run and outbox, stop the standalone WhatsApp bridge, then run:

```bash
npm run whatsapp:handoff -- legacy
```

The command takes the same device lock, verifies no unsettled relay work or unprojected events,
checks conversations are idle/finished, refuses outstanding scheduled occurrences, exports task
changes to the legacy table, and marks the ledger ready for the **updated** legacy host. It sends
nothing. Only then start that host. The shared server can keep serving other bridges.

At re-cutover, stop the legacy host again. Identity progress remains shared; task changes and deletions
made during rollback are imported. Do not delete the journal or replay old JSON into an initialized
ledger. Do not roll back to an older binary that ignores the journal.

`delivery_unknown` and parked interrupted tools require inspection of the actual outcome before an
operator explicitly reconciles them. Media spool files are retained for reconciliation; clean them
only after their delivery records no longer need replay or inspection. Permanent service replacement
and soak remain tracked separately from implementation.
