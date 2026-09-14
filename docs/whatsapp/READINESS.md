# WhatsApp readiness: controlled text test, then cutover

Audited 2026-09-14 against SmolPaws `c344f79` (#170) and SDK `369b9c5` (#28).
The standalone bridge and shared relay are implemented. A live text test still needs history-safe
startup and a reproducible provider/server preflight. Permanent replacement has additional gates.
Beads is the status owner: `smolpaws-zlo`, `smolpaws-kxa` and the children below.
The [architecture page](https://enyst.github.io/arch/whatsapp-readiness.html) explains this plan visually.

## Evidence and limits

- The deterministic [real-server relay test](../../apps/whatsapp/src/__tests__/realServerRelay.test.ts)
  exercises a fake WhatsApp socket, real in-process TypeScript server/agent, test LLM, durable relay,
  mid-turn `send_message` and final text. It does not prove a live provider or transport.
- SDK #28 tolerates harmless extra provider tool-call fields while retaining required-field validation.
  The upstream SDK is fixed; the server vendor must include it reproducibly. A local bundle patch is
  insufficient deployment evidence. Follow the [re-vendor runbook](../../packages/openhands-agent-server/docs/REVENDOR_AUTOMATION.md).
- Read-only Mac preflight on the audit date: legacy WhatsApp service running; no listener on the new
  server's default `:8790`; existing ledger has no new relay cursor table. No live WhatsApp send or
  service swap was performed. This is a dated observation, not a monitoring feed.

## Gate A: history-safe startup and state isolation — kxa.6

The old loop reads `data/router_state.json` (`last_timestamp`, `last_agent_timestamp`). The new
[ledger](../../apps/whatsapp/src/ledger.ts) reads SQLite `relay_state`, including `dispatch_cursor:<chat>`
and `last_agent_ts:<chat>`, and defaults to sequence zero. It does **not** import the legacy JSON.
Starting against the historic ledger can therefore replay old messages. The existing ledger tests
cover SQL cursor values, not the actual production JSON handoff.

Implement and test an explicit stopped/drained baseline or import policy that preserves pending work.
Include late offline arrivals, equal timestamps, duplicate inbound rows, and legacy `INSERT OR REPLACE`
after the new `messages.seq` schema exists. Record which messages have been handled across both systems.
Rollback must reconcile this state: the legacy process does not read the new sequence cursors.

Specify each state boundary explicitly:

| Boundary | Required decision |
|---|---|
| WhatsApp account/auth | One active socket owner. Reusing a link does not permit two processes. |
| Ledger | Explicit path and tested history baseline; preserve pending messages. |
| Registered chats | Explicit `SMOLPAWS_WHATSAPP_REGISTERED_GROUPS` file containing only the trusted control chat. |
| Relay database | Explicit separate path exposed by the entrypoint; `SMOLPAWS_HOME_DIR` currently does not move it. |
| Server persistence | Separate canary persistence or a deliberately reconciled existing conversation. Fresh relay DB alone is insufficient. |
| Workspace/context | Existing `groups/<scope>` directory; verify intended context and tools. |
| Startup notification | Suppress or include the automatic “I'm up” ping in the authorized test. The entrypoint currently exposes no suppression setting. |

Conversation IDs derive directly from lanes. Keep that design: a filename suffix is not a conversation
namespace, and introducing versioned namespaces is not the solution. The relay projects persisted lanes,
so an allowlist change alone is not sufficient isolation either.

## Gate B: reproducible engine and real-provider preflight — kxa.7

1. Re-vendor the fixed upstream SDK through the server runbook and verify the clean build.
2. Verify the intended server package/revision, persistence path, endpoint authentication and working
   directory. The launcher accepts a healthy endpoint without verifying which build owns it.
3. Inspect the new server's active LLM profile and provider credential availability without exposing
   values. Legacy `LLM_PROFILE_ID` does not select the new server profile. Do not silently choose a model.
4. Check configured tools. The factory fallback includes `finish` but omits `send_message`; enable the
   latter when validating mid-turn delivery. Group defaults select `groups/<scope>` over the common cwd.
5. Run an internal real-provider tool round trip and continuation before opening a WhatsApp socket.
   Save sanitized evidence. Provider compatibility belongs in SDK provider clients/helpers, according to
   the [provider guide](https://github.com/smolpaws/openhands-agent/blob/main/docs/LLM_PROVIDERS.md).

## Gate C: controlled one-chat text canary — kxa.5

After A and B pass, agree a bounded live-send window and a single trusted control chat. Stop/drain the
legacy socket owner during a same-account test; account for scheduled work during the window. Record
state paths and the tested rollback procedure before starting. Existing credentials can be reused.

Verify all six boundaries for a unique test input:

1. The inbound message exists in the ledger.
2. Its durable intake reaches `done`.
3. The expected server conversation contains its user event and a completed run.
4. Expected mid-turn/final delivery rows exist.
5. Each delivery settles `done` with `send_attempted = 1` and an external WhatsApp message ID.
6. The reply appears once in the intended chat with the `smolpaws: ` prefix.

Then exercise duplicate inbound replay, a restart with queued outbound before socket readiness, and
reconnection. An ambiguous send stays `delivery_unknown` until reconciled; never blindly retry it.
A visible reply alone is insufficient. This gate proves text transport, not full channel replacement.

## Additional gates for permanent replacement

| Owner | Remaining behavior and proof |
|---|---|
| `smolpaws-kxa.4` | Scheduler consumer, scoped task actions and due tasks as synthetic relay intake; prove create/update/pause/resume/cancel, restart and delivery. |
| `smolpaws-kxa.2` | Outbound media and voice notes/PTT. Ingress media exists; the current delivery target is text-only. |
| `smolpaws-kxa.8` | Per-scope context and permissions. Shared private memory currently reaches every registered chat; changing cwd is not a security boundary. Verify intended context before adding groups. |
| `smolpaws-kxa.9` | Socket creation failure retry, transient network-error handling, queued outbound recovery and shared-server recovery ownership. The launcher checks the detached server only at bridge startup. |
| `smolpaws-39y` | Bound stalled HTTP requests so conversation creation cannot block the sequential chat poll loop. Not awaiting an LLM run does not solve a hung HTTP call. |
| `smolpaws-b1r.24` | Rehearsed cutover/rollback preserving pending and handled work, followed by soak; all-ingress migration and legacy-server retirement remain broader work. |

Do not permanently stop the root service while it still owns required scheduled tasks and voice delivery.
After the gates pass, swap LaunchAgents with one socket owner, verify the same acceptance probes and
observe the agreed soak window. Keep rollback available until its cursor handoff is proven. Retire
`apps/agent-server` only after GitHub, email and all other remaining clients have migrated.

## Source map

- [Legacy cursor loading](../../src/index.ts), [legacy ledger writes](../../src/db.ts).
- [New ledger](../../apps/whatsapp/src/ledger.ts), [adapter](../../apps/whatsapp/src/adapter.ts),
  [entrypoint](../../apps/whatsapp/src/index.ts), [configuration](../../apps/whatsapp/src/config.ts).
- [Relay runtime](../../src/coordinator/relayRuntime.ts), [lane identity](../../src/coordinator/ids.ts),
  [HTTP client](../../src/coordinator/httpAgentServerClient.ts).
- [Profile agent factory](../../packages/openhands-agent-server/src/profileAgentFactory.ts),
  [launcher](../../scripts/run-local-bridge.sh), [Message Relay design](../../src/coordinator/DESIGN.md).
