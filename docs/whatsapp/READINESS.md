# WhatsApp readiness: iPad canary passed; overnight soak running

Updated 2026-09-15. The standalone bridge now includes the history handoff (`kxa.6`), shared scheduler
(`kxa.4`), outbound media/voice (`kxa.2`), existing scope rules (`kxa.8`), recovery (`kxa.9`) and bounded
HTTP intake (`39y`). SDK #32 is vendored at `5f28eb8`, including SDK #31 subscription OAuth, #30 bridge tools, provider
fix #28 and the multi-tool thought correction. Beads owns completion and deployment status.

Real-provider preflight passed on 2026-09-15: SmolPaws `7a98ef1`, SDK `573ec5d`, the configured
`deepseek-v4-flash` profile and its normal Keychain reference. A temporary real product host verified
the product header and completed two consecutive turns, each with a `list_tasks` observation and
`finish` carrying the expected marker. No bridge socket, live WhatsApp send or service swap was used.
A bounded connection trial followed on 2026-09-15, 05:39–05:49 UTC: an isolated product host on
`:8791` ran SmolPaws `822bb24` with SDK `775869e`, the same active profile and separate persistence.
Its provider validation passed; the bridge reused the existing account with only Main allowlisted,
startup ping disabled and zero offline messages. No test input arrived and the relay stayed empty.
The drain/handoff check passed and the updated legacy bridge reconnected with its scheduler running.
This proves connection and an empty-work rollback, **not** a live reply or recovery under load.

The trial also exposed an inherited relay database override: the native host must use a separate
work store from its launching bridge. `SMOLPAWS_AGENT_SERVER_RELAY_DB_PATH` now owns the native
override; `SMOLPAWS_RELAY_DB_PATH` remains bridge-specific. The trial used separate stores before
opening the socket. The existing bare `:8790` server remains unchanged. At that point, the remaining gates were the
final deployed product-host check (`kxa.7`), live one-chat canary (`kxa.5`) and production soak.
The evening evidence below closes the first two; overnight soak remains open.
See [shared design](../bridges.md) and [architecture page](https://enyst.github.io/arch/whatsapp-readiness.html).

## September 15 iPad canary

During 18:19–18:30 UTC, the iPad input reached the ledger and durable relay. A 422 exposed an
oversized launch suffix (64,997 characters versus upstream’s 32,768 cap). Product fix #175 keeps
identity inline and references oversized files for reading; the corrected Main suffix was 18,300
characters. Retrying the original intake completed the agent run. The user confirmed text replies
on the iPad, but two identical outputs exposed the `send_message` plus `finish` echo (bead 955).

A real image and OGG/Opus voice note were queued while the bridge was stopped. Both remained
`ready` with no send attempt, then reached `done` with external WhatsApp IDs after reconnect. The
user confirmed the image and playable voice. The agent failed before scheduling: a two-tool response
duplicated its thought into both ActionEvents, and SDK history reconstruction rejected the next
step (bead 956). SDK #32 repairs construction against pinned Python; fresh history is required or
old malformed events must be explicitly reconciled without repeating completed effects.

All delivered effects were accounted for, the unfinished scheduling request was abandoned, and
rollback restored legacy at 18:30:20 UTC with its scheduled tasks unchanged. This trial proves text,
media playback and queued-media restart, not scheduled delivery or permanent replacement. The user
authorized leaving the corrected Main-only canary running overnight.

## September 15 overnight canary — running

The Main-only bridge connected at 18:49:36 UTC on merged SmolPaws `c4ba8c4` with SDK `5f28eb8`,
using the existing `deepseek-v4-flash` profile. Separate bridge/native relay stores and fresh server
persistence avoid the earlier malformed history. The product host passed a real-provider two-tool
batch (`list_tasks` and `think`), then continued its saved conversation after a process restart.

An operator request through the actual Main conversation deliberately used `send_message` and
`finish` with identical text. Fix #176 produced one `NIGHT-CANARY READY` delivery. Its once task
then produced one `NIGHT-SCHEDULE OK` delivery. Each reached `done` with one send attempt and an
external message ID; the user confirmed one visible copy of each on the iPad. This scheduled test
was a direct operator request, while the earlier text test was real WhatsApp ingress. Offline replay
of that captured intake at the relay acceptance boundary preserved the same completed work row
without another server call or platform send.

The canary host and WhatsApp bridge run under dedicated KeepAlive LaunchAgents. Legacy WhatsApp
is stopped and disabled so it cannot compete for the device after reboot; its updated code remains
available for rollback. Existing Main tasks were preserved. The next existing Main cron is due
September 16 at 07:00 UTC. The other local servers and ingress services were left unchanged.

Deployment and controlled-canary beads `kxa.7` and `kxa.5` are closed. **Overnight observation remains
open as `smolpaws-957`**: inspect service health, actual replies, scheduled work and unsettled effects
before deciding permanent cutover. All-ingress retirement remains `b1r.24`. These are timestamped
observations, not a promise of continuous monitoring. The private runtime directory contains the
exact service configuration, evidence and rollback procedure; never restore old auth or ledger
snapshots over progress made during the canary.

## Implemented and tested

| Capability | Behavior and evidence |
|---|---|
| History | Import the actual legacy `data/router_state.json` once into per-message identity progress in the ledger. Preserve pending, same-second and late arrivals; duplicate inserts cannot reset progress. Both updated host generations use that journal. `historyHandoff.test.ts`. |
| Isolation | One process lock per auth directory; explicit ledger/relay/allowlist paths; startup-ping control; refuse persisted lanes outside the allowlist. A persisted relay owner tag rejects adoption of an unrelated server EventLog. `historyHandoff.test.ts`, HTTP tests. |
| Scheduler | One shared SQLite store, real task-tool observations, scoped lifecycle commands, cron/interval/once, group/isolated runs and idempotent synthetic intake. Real profile/server tests across WhatsApp, Slack, Discord and direct API conversations. |
| Media | Immutable local spool and durable delivery rows; image/video/audio/document delivery. WhatsApp OGG/Opus PTT and the existing private `voice-outbox.jsonl` producer are supported. Outbound IDs suppress media echoes on the shared account. File and symlink scope checks; fake transport tests. |
| Scope | WhatsApp `groups/<folder>` and existing control semantics: `main` can manage tasks across scopes; other scopes see/manage their own. Private durable memory is supplied inline or by file reference only to WhatsApp control context. No new sandbox or delegation model. |
| Recovery | Durable acceptance requires no server request. HTTP deadlines include response bodies; interrupted tool outcomes are parked; disconnected delivery waits; timed-out sends stay `delivery_unknown`; reconnect creation retries; one shared child supervisor restarts the server. |

The deterministic tests use fake platform transports and a test LLM with the real TypeScript
server/agent. They prove the local path, not provider availability or live media playback.

The canonical packed SDK subscription path also passed on 2026-09-15 using the existing OpenHands
OAuth account and `gpt-5.5`: profile preflight, two `think`/`finish` tool round trips and continuation,
with temporary server state and no bridge sends. `authType: "subscription"` profiles use the SDK's
private credential store; the deployed active model was not changed. The server-side device-login
endpoints and restart/refresh path have deterministic HTTP and persisted-conversation coverage.
See [subscription architecture](../../packages/openhands-agent-server/docs/ARCHITECTURE.md#chatgpt-subscription-profiles).

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
   `SMOLPAWS_HOME_DIR` now relocates the default relay path as well as WhatsApp state. The native
   host uses its own relay database beside the scheduler; use `SMOLPAWS_AGENT_SERVER_RELAY_DB_PATH`
   only if it needs an explicit path. Never point two platform workers at one work database.
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
checks conversations are idle/finished, refuses outstanding scheduled occurrences or partially imported voice batches, exports task
changes to the legacy table, and marks the ledger ready for the **updated** legacy host. It sends
nothing. Only then start that host. The shared server can keep serving other bridges.

At re-cutover, stop the legacy host again. Identity progress remains shared; task changes and deletions
made during rollback are imported. Do not delete the journal or replay old JSON into an initialized
ledger. Do not roll back to an older binary that ignores the journal.

`delivery_unknown` and parked interrupted tools require inspection of the actual outcome before an
operator explicitly reconciles them. Media spool files are retained for reconciliation; clean them
only after their delivery records no longer need replay or inspection. Permanent service replacement
and soak remain tracked separately from implementation.
