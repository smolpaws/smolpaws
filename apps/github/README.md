# GitHub ingress and hosted agents

Implementation notes, 2026-10-22. The managed routes are **disabled by default**.
This change does not provision D1, install a GitHub app, deploy the Worker, or
start paid sessions. Account access, pinned models and a controlled live canary
remain tracked under `smolpaws-naf1.2` and `smolpaws-naf1.5`.

## Ownership

The existing Worker owns both GitHub ingress paths. `src/managedAgents/` owns
hosted requests through `accept`, `tick` and `status`. It imports no agent core,
coordinator, identity files, local conversations or runner protocol. D1 stores
its frozen requests, admission reservations, scan continuations, leases, session
receipts, reply outbox and generated comment IDs. The existing minute cron
advances work; no managed Queue, Workflow or callback endpoint is required.

`src/durableIntake.ts` owns the optional legacy Queue handoff for the SDK repo.
It preserves the existing Queue message and stable delivery identity. Other
repositories retain their existing ingress policy. This is durable admission,
not an exactly-once guarantee for local runner execution.

OpenAI uses the Agents API hosted Codex harness (`agents=v1`). Claude uses
Managed Agents (`managed-agents-2026-04-01`), a pinned saved-agent version, an
explicit model override and a hosted environment. Each session includes its
initial input in its creation request. Neither adapter retries creation after an
ambiguous response. Claude receives no vaults, memory resources or MCP servers;
its saved agent and environment must pass the preflight below.

## Configuration and cutover

Start from [managed-agents.example.json](managed-agents.example.json). It is valid
disabled configuration, not a production model or account selection. Install it
as the `MANAGED_AGENTS_CONFIG` Worker variable. An absent variable preserves the
existing routes. Once present, authored `@codex` / `@claude` commands in the SDK
repo are reserved for managed routing, including when disabled or rejected.
Plain SmolPaws requests retain the existing path and actor policy.

Before enabling anything, provision a D1 database and add its real binding to
the deployment configuration. Do not deploy a placeholder database ID:

```toml
[[d1_databases]]
binding = "GITHUB_DB"
database_name = "smolpaws-github"
database_id = "<actual provisioned ID>"
migrations_dir = "migrations"
```

Apply `migrations/0001_managed_agents.sql` using Wrangler's D1 migrations command
against that database before deploying code which enables either D1 path. A
plain deployment with no managed configuration or durable-intake baseline needs
no D1 binding. The checked-in Wrangler configuration remains in that state.

The Worker secrets for this module are:

| Secret | Purpose |
| --- | --- |
| `MANAGED_OPENAI_API_KEY` | OpenAI account with Agents API access |
| `MANAGED_ANTHROPIC_API_KEY` | Claude account with Managed Agents access |
| `MANAGED_AGENTS_SERVICE_TOKEN` | Dedicated random bearer credential, at least 32 characters, for direct intake/status |
| `GITHUB_USER_TOKEN` | Existing **smolpaws** credential for public reads and ordinary replies |

No enyst maintainer credential is read or sent to a provider. Before paid
dispatch and publication, `/user` must return writer ID `255025612`; a writer
failure cannot fall back to a stronger identity. Provider keys never enter
prompts, D1 request/status data, the local runner configuration or the tool client.

For the legacy D1 cutover, set `GITHUB_DURABLE_INTAKE_BASELINE` to an explicit UTC
timestamp. Pause the old ingress during cutover, let already queued work drain,
and retain its Cache receipts. Choose a baseline at cutover; comments created
before it are excluded even after Cache expiry. The baseline can advance and
cannot move backwards in D1. Accepted handoffs survive failed Queue sends and
are retried by cron. An ambiguous Queue acknowledgement can enqueue the same
stable delivery ID again. Do not erase pending receipts or existing Queue data.

Managed comment intake has its own `poll.activation_timestamp`. A null shadow
baseline is persisted on its first scan; **active mode requires an explicit
timestamp**. Shadow and suppressed requests never turn into paid work when a
flag changes. Use new requests after setting an activation baseline.

Independent controls:

- `enabled` / `mode`: master lifecycle and shadow/active selection. Keep active
  monitoring running for existing paid sessions; changing to shadow or disabling
  the master stops that monitoring too.
- `poll.enabled`: pause new GitHub intake while continuing existing sessions.
- `direct_intake.enabled`: pause direct admission.
- `routes.codex.enabled` / `routes.claude.enabled`: pause new provider dispatches.
- `publication.comments_enabled`: pause replies while monitoring continues.

## Admission, recovery and replies

The repository is resolved by immutable ID `1043426082`, currently
`OpenHands/software-agent-sdk` (`OpenHands/agent-sdk` is an alias). Only source
author IDs `6080905` and `255025612` authorize hosted work. The general
`ALLOWED_ACTORS` list cannot extend that policy. GitHub source metadata is fetched
again; a caller's claimed identity cannot authorize a request.

Issue comments, PR conversation comments and inline review comments are polled
from both repository feeds. Markdown quotes, code, escaped handles, URL
destinations and longer handles are excluded. Both real provider mentions admit
one job each. Comment edits retain the first admitted prompt; deleting a source
or removing its mention before dispatch cancels it. Generated IDs and reserved
output markers exclude replies while retaining legitimate SmolPaws requests.

Each feed retains a completed cursor, scan start and validated pagination URL.
Page/time limits save a continuation. Five-minute overlap, alternating feed
priority and daily re-enumeration from the activation baseline repair delayed
observations. Polling cannot see comments deleted before observation. An updated
baseline never replays older sources.

The approved request is limited to 16 KiB. Labeled discussion context is limited
to 20 comments / 32 KiB, including inline location metadata. Jobs pin the PR head
or default-branch commit before execution. Replies identify the configured
provider/model and that assessed SHA, and flag a moving target.

Admission reserves a conservative $5 per job by default against $20/day, so the
default permits **four** paid admissions/day, subject to the separate 20-request
ceiling. Reservations are atomic and are not refunded automatically. They are
not actual invoices or a guaranteed billing cap. Claude also receives a $5
session limit; an in-flight request may overshoot. OpenAI billing limits require
account preflight. At most two jobs run concurrently, with one per thread/provider.

The twenty-minute watchdog records one cancellation attempt before sending it.
Cancellation acknowledgements and idle states do not prove success. Permission
waits, budget pauses, open Claude workflows and missing final output remain
pending. Provider read failures back off. Excessively long saved histories
require operator action; V1 re-reads bounded history rather than persisting
incremental provider event cursors or cost reconciliation.

`dispatch_unknown` requires an operator to locate the remote session; it is never
retried as another paid creation. `delivery_unknown` reconciles the stable marker
and immutable writer ID before any repeat publication. No conclusive receipt
means no blind repost. Reconciliation checks up to 2,000 destination comments;
larger histories remain action-required. A late session receipt can recover an
expired dispatch lease. A late lease owner cannot overwrite newer progress.

An action status and an outcome have separate outbox rows. Known status comments
are edited in place. Lost edit acknowledgements require the saved comment ID and
matching payload, not just an old marker. A posted status does not complete the
job. A lost status response does not disable the paid-session watchdog.

## Direct tools

`src/managedAgents/client.ts` exports `ask_codex`, `ask_claude` and
`managed_agent_status` transports. The calling runtime supplies only the Worker
HTTPS origin and its service token. This PR supplies the transport; registration
in a particular SmolPaws tool host is a separate integration, without changing
the core or giving it provider credentials.

```http
POST /managed-agents/requests
Authorization: Bearer <dedicated service credential>
Content-Type: application/json

{"provider":"codex","clientRequestId":"stable-caller-id","repositoryId":1043426082,"issueNumber":123,"body":"Review this PR"}
```

The service credential fixes the principal to smolpaws. Payload identity fields
are rejected. Retain `clientRequestId` across retries; a changed prompt or reply
destination under the same provider/ID returns 409. The JSON envelope is capped
at 24,000 bytes and the approved text at the configured request limit. A valid
destination is fetched from GitHub before admission.

`GET /managed-agents/runs/<run-id>` uses the same credential and returns redacted
progress, assessed commit and action-required reason, without prompts or output.
There are no provider webhook endpoints, branch publication, labeling, maintainer
actions, formal review verdicts or merges in V1.

## Verification and live preflight

```bash
npm ci --prefix apps/github
npm test --prefix apps/github
npm run typecheck --prefix apps/github
npm run typecheck
```

Tests run the production SQL migration against SQLite. Only GitHub, provider and
Queue effects are fixtures; no live tokens or paid sessions are used. The Worker
lifecycle fixture reaches one attributed reply with the local runner unreachable.

Before activation, verify account API access, actual pinned model availability,
Claude saved-agent permissions/version and environment networking. Disable its
multiagent workflows and custom tools for V1; provision a clean environment with
no baked-in credentials or private memory. Verify public clone access, fetching
the exact PR SHA and the SDK's real test dependencies. Run a controlled public
fixture through both providers; capture actual cost, final-output shape,
permission/budget behavior, cancellation and lost-response recovery. Then enable
shadow enumeration on the target, inspect receipts, and select a new active
baseline before bounded replies. These steps are pending, not implied by mocked
test success.

Sources checked 2026-10-22:
[OpenAI sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions),
[hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted),
[Claude sessions](https://platform.claude.com/docs/en/managed-agents/sessions),
[saved events](https://platform.claude.com/docs/en/api/beta/sessions/events/list),
[Claude budgets](https://platform.claude.com/docs/en/managed-agents/budgets).

The original [integration contract](docs/managed-agents-contract.md) retains the
design acceptance criteria. [Handoff mapping](docs/managed-agents-handoff.json)
records the transfer to SmolPaws Beads. The broader design is in the
[notebook](https://enyst.github.io/arch/github-mention-router.html).
