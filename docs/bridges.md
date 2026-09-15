# Bridges: how they start and what they share

A bridge is one channel's front door. Every bridge on the new stack is a **standalone process** that
attaches to the shared TypeScript OpenHands agent-server through the Message Relay. Nothing runs
"inside the app" anymore; the app is the set of bridges plus one server.

## Process topology

```text
launchd (macOS)
  ├─ com.smolpaws.bridge.whatsapp ─┐
  ├─ com.smolpaws.bridge.slack ────┼─ scripts/run-local-bridge.sh <bridge>
  └─ com.smolpaws.bridge.discord ──┘        │
                                            ├─ health-check http://127.0.0.1:8790/health
                                            ├─ (if down) supervised apps/relay-server (product host)
                                            └─ exec npm --prefix apps/<bridge> run start
                                                       │
                               ┌───────────────────────┴────────────────────────┐
                               │ apps/<bridge>                                   │
                               │  platform socket → RelayRuntime (SQLite)        │
                               │    → POST /api/conversations/{id}/events run    │
                               │    → GET  /api/conversations/{id}/events/search │
                               │    → DeliveryTarget → platform send             │
                               └─────────────────────────────────────────────────┘
                                                       │
                                     apps/relay-server → packages/openhands-agent-server  :8790
                                     (persistence: ~/.smolpaws/conversations)
```

Rules:

- **Any bridge can boot the server.** The launcher starts the agent-server when nothing healthy answers
  on the loopback URL, under one detached supervisor, and never stops it. The supervisor restarts the child after failure; a process lock prevents duplicate supervisors. Whichever bridge comes up first
  wins; the others find the server healthy and just attach.
- **Bridges restart independently.** `KeepAlive` on each LaunchAgent restarts a crashed bridge without
  touching the server or the other bridges.
- **One durable store per bridge.** `~/.smolpaws/coordinator/<platform>-relay-v1.db` holds that
  platform's lanes, intake, and delivery rows. Lane keys are `<platform>:<account>:<chat>` and the
  conversation id is derived deterministically from the lane key, so a lane always finds the same
  conversation again and an old EventLog from a different id space is never re-delivered. (Slack keeps
  its earlier `channel:slack:…` keys and `slack-relay:v1` ids so lanes already on disk stay bound.)
- **Deliveries wait for the transport.** A bridge starts its relay worker only once its platform
  client is usable (WhatsApp socket open, Discord `clientReady`, Slack Socket Mode connected), and
  the dispatcher never claims a delivery while the transport is down. A reply queued when the process
  died stays `ready` until the next connection and then goes out once; it is never marked
  `delivery_unknown` because of a send that could not start.
- **The server knows nothing about channels.** Delivery, ordering, retries, and idempotency stay in the
  relay; the server stays upstream-shaped.

## Commands

```bash
npm run bridge:start -- whatsapp                    # foreground: server if needed, then the bridge
npm run bridge:launchagent:install -- whatsapp      # supervised
npm run bridge:launchagent:remove -- whatsapp
npm run slack:relay:local                           # same as bridge:start -- slack
```

Logs: `~/.smolpaws/logs/bridge.<bridge>.launchagent.log`, `~/.smolpaws/logs/openhands-agent-server-8790.log`.

`~/.smolpaws/.env` is loaded by the launcher for every bridge (tokens, `SMOLPAWS_RELAY_SERVER_URL`,
`SMOLPAWS_RELAY_SERVER_API_KEY`, `SMOLPAWS_WORKING_DIR`).

## What every bridge shares

| Concern | Where |
|---|---|
| Durable intake, lane→conversation binding, outbox sync, dispatch loop | `src/coordinator/relayRuntime.ts` (`RelayRuntime`) |
| What counts as deliverable | `src/coordinator/messageRelay.ts` extractors (`terminalResponseExtractor` and `sendMessageExtractor` for all three bridges) |
| Agent-server HTTP client, per-lane creation defaults | `src/coordinator/httpAgentServerClient.ts` |
| Workspace + SmolPaws identity context for new conversations | `src/shared/relayConversationDefaults.ts`, `src/shared/smolpawsContext.ts` |
| Launch + supervision | `scripts/run-local-bridge.sh`, `launchd/com.smolpaws.bridge.plist`, `scripts/install-bridge-launchagent.sh` |

### Conversation defaults

When a lane is first seen, the bridge creates the agent-server conversation with:

- `workspace.working_dir`: a real directory. Slack uses `SMOLPAWS_WORKING_DIR`, else
  `SMOLPAWS_WORKSPACE_ROOT/SMOLPAWS_DEFAULT_WORKING_DIR` (default `~/repos/smolpaws`), else this
  checkout. WhatsApp uses `groups/<scope>` under the checkout, per registered chat.
- `tags.ingress`: the bridge name (WhatsApp adds `tags.scope`).
- `agent_launch_additions.system_message_suffix_append`: the SmolPaws identity docs
  (`docs/smolpaws/*.md` except README/HEARTBEAT; WhatsApp adds private `MEMORY.md` only for `main`)
  framed as `<SMOLPAWS_CONTEXT>`. This is the upstream agent-server field for deployment context: the
  server resolves the agent from its profile first and only then appends the suffix as the SDK
  `AgentContext.system_message_suffix`, so the cat is paws in every channel without any bridge
  overriding agent settings. Without it the model answers as a generic assistant.

Bridges do not send `agent` at all; the agent and its LLM profile stay the server's choice.

## Status per channel

| Channel | Shape | State |
|---|---|---|
| Slack (`paws`) | standalone relay | live in Liberty Labs; identity context + workspace fix landed with this change |
| WhatsApp | standalone relay | implemented (`apps/whatsapp`), deterministic end-to-end test green; needs the live six-point canary on the Mac, then cutover; scheduler, outbound media/voice and recovery implemented; live provider/transport checks pending |
| Discord | standalone relay | rewritten on the relay (`apps/discord`: Gateway → handler → `RelayRuntime` → `DiscordDeliveryTarget`), deterministic end-to-end test green; needs a live check in the test server |
| GitHub, email | Cloudflare Workers → `/turns` on the legacy runner | unchanged; migrate to relay intake after WhatsApp soaks |
| Heartbeat | LaunchAgent → shared product host (`:8790` by default) | uses the same supervised startup and product-host check as bridges; session-key authentication and absolute workspace |

## Shared scheduler and media tools

`apps/relay-server` composes the transpiled package through its optional `configureTools` factory hook.
SDK tools remain ordinary EXT-SDK-001/002 definitions. Their host executors receive the durable action
ID and return real task IDs, lists or validation errors. Scheduling and delivery stay outside the
upstream-shaped server package and its wire schemas. Start the product host with
`npm run relay-server:start`; use the bare package CLI only when product services are unnecessary.

One `coordinator/scheduler.db` is shared by all standalone bridges and native API conversations
(`SMOLPAWS_SCHEDULER_DB_PATH` overrides it). It stores lane registrations, tasks, deduplicated commands
and occurrences. `schedule_task`, `list_tasks`, `update_task`, `pause_task`, `resume_task`, and
`cancel_task` keep the old scope rule: control `main` can target registered scopes; everyone else
manages their own. Native API conversations get their own scope; an HTTP tag cannot grant control.
Cron uses `TZ` or the host timezone; intervals use milliseconds and once schedules use timestamps.

Each relay keeps its own work database. `SMOLPAWS_RELAY_DB_PATH` selects a bridge's store;
the product host ignores that override for its native API worker and uses `agent-server-relay-v1.db`
beside the scheduler, or `SMOLPAWS_AGENT_SERVER_RELAY_DB_PATH` when explicitly configured. Sharing
a scheduler does not permit two platform dispatchers to claim work from the same relay store.

Each bridge reserves its due occurrences and submits them through the existing durable intake.
`context_mode=group` uses the existing conversation; `isolated` creates a conversation per occurrence,
keeping scope, workspace and destination but never copying the original initial message. Run IDs and
source event IDs survive retries. Recurring tasks calculate the next run after completion, as before.
Pausing stops future submission; cancelling does not revoke a run already submitted to the agent.
WhatsApp imports the legacy `scheduled_tasks` table while the old scheduler is stopped and exports it
for rollback. GitHub/email still use the legacy runner until their ingress migration; this change does
not switch those deployed consumers.

`send_media` accepts a workspace path, media type, optional caption/MIME and voice-note flag. The host
validates the file (including symlink scope), copies complete immutable bytes into `outbound-media/`,
and queues delivery before acknowledging it. WhatsApp sends native media and OGG/Opus PTT; Slack uses
file uploads; Discord uses attachments. Voice-note flags become ordinary audio attachments on those
other platforms. Native API conversations without a bridge report that media delivery is unavailable.
The existing private WhatsApp `voice-outbox.jsonl` producer feeds this same outbox. Provider upload
limits still apply; voice generation/transcoding is unchanged. Spool files are retained for diagnosis.

## Recovery and ownership

The ledger journals handled message identities so old timestamps cannot reset progress. The relay
persists its own owner identity and refuses to adopt a server conversation from an unrelated store.
No conversation-ID version bump is used for WhatsApp isolation. The allowlist is checked against
persisted destinations before a socket is opened; `SMOLPAWS_WHATSAPP_STARTUP_PING=0` suppresses the ping.

Accepting ingress commits locally without waiting for HTTP. Server requests have a 15-second deadline,
including body reads. A supervisor restarts a failed shared server child; it does not own bridge
lifetimes. WhatsApp reconnects with bounded backoff, including socket-factory failures, and fences old
socket callbacks. The existing transient network guard is shared with the legacy host.

The relay resumes idle interrupted requests when all observed tool actions have outcomes. An action
without an observation may already have acted: park that run for reconciliation and pause its scheduled
task. Provider errors are recorded as failed scheduled runs. Explicit pauses are respected. A platform
send timeout (30 seconds) remains `delivery_unknown`, never automatic retry. Transport-disconnected
work remains `ready`. These mechanisms do not claim exactly-once delivery from external APIs.

Proof: `npm run coordinator:test`, `npm run relay-server:test`, bridge tests/typechecks, and the full
transpiled package CI. The [WhatsApp readiness checklist](whatsapp/READINESS.md) records the remaining
live-provider, transport and service-cutover work.

### Launch context size

The upstream server limits `agent_launch_additions.system_message_suffix_append` to 32,768
characters. The shared bridge context renderer keeps complete documents inline while they fit.
When the combined context is larger, it replaces the largest documents with explicit local-file
references and an instruction to read them before answering. It preserves the original files and
does not truncate them. This normally leaves the small identity documents inline and references
large private memory. WhatsApp still supplies private memory only for its control scope.

### Final replies after explicit sends

The relay suppresses a terminal reply that repeats text already queued by `send_message` in the
same turn. It reads the durable EventLog back to the previous user message or terminal reply and
checks the corresponding outbox record, so paging, cursor replay and process restart do not change
the decision. It preserves explicit repeated sends, different final text, and identical text in a
later turn. No provider or agent-loop rule owns this channel delivery policy.

### Heartbeat startup

Heartbeat and bridge launchers share `scripts/lib/product-server.sh`. They reuse an endpoint only
when `/health` identifies the SmolPaws product host (`X-SmolPaws-Host: relay`), and bootstrap the
supervised `apps/relay-server` locally when absent. A healthy bare SDK server is rejected with an
upgrade instruction; it is never silently replaced or treated as a server with product tools.
Heartbeat prefers `SMOLPAWS_RELAY_SERVER_URL`, then the coordinator alias, then its older explicit
`SMOLPAWS_RUNNER_URL` override. The default remains loopback port 8790. Session authentication uses
`X-Session-API-Key`; the legacy runner Bearer token is not used. Preserve the existing conversation
and server-state directories when replacing a bare host, and drain active work first.

Each heartbeat tick creates or reuses its daily conversation, appends a message with a stable
per-minute event ID, and starts a run only for a newly appended tick. Repeating conversation
creation alone does not run another turn. Failed submissions remain visible in the LaunchAgent
error log; a successfully queued tick is not evidence of a completed agent run.
