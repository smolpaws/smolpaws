# Integration contract

Draft dated 2026-10-12, revised 2026-10-14. The proposed implementation extends
`smolpaws/apps/github`. These are implementation invariants, not deployment claims.
See the notebook for sources and rationale.

Implementation handoff: 2026-10-22, epic `smolpaws-naf1`. This document preserves
the agreed design acceptance criteria, including later work. See
[the app runbook](../README.md) for implemented scope and setup. Initial code is
disabled; live account/cost/dependency canaries are pending. In V1 the adapters
re-read bounded saved history, without incremental event cursors or invoice
reconciliation; durable legacy handoff is scoped to the target SDK repository.
The direct tool transport is provided without registration in the agent core.

## Module placement and interface

Keep hosted routing in `apps/github/src/managedAgents/`, with a small interface:

- `accept(request)`: validate a normalized, verified request and durably admit it,
  returning the existing run for an identical retry.
- `tick()`: claim due rows, perform bounded work, save progress and exit.
- `status(runId)`: return bounded progress and any action required from an operator.

The Worker wires the module to D1, a clock, HTTP access and the GitHub comment
writer. Provider session formats stay inside OpenAI and Claude adapters.
Do not import the local runner protocol, agent-server, coordinator, personal
memory or identity documents into this module. Provider keys are supplied only
to the managed path; the ordinary runner gets its existing configuration subset.

Select managed intent before the ordinary SmolPaws runner path. A recognized
managed command is consumed even when rejected; it must not fall through into
a local SmolPaws run. Plain SmolPaws requests retain their existing queue path
and authorization policy. Its general `ALLOWED_ACTORS` setting must not expand
the hosted-provider author allowlist.

Use one D1 database for shared durable intake receipts and managed job state.
Replace Cache API mention admission for both paths. Legacy queue handoffs need
durable pending receipts and their existing delivery identity, so a crash between
admission and enqueue can be recovered. This does not claim exactly-once local
runner execution or migrate its conversation state into the router.

Before replacing legacy deduplication, establish a migration baseline/receipts
for earlier processed mentions. Preserve queued messages and demonstrate that
the existing notification lookback does not replay them. Keep the module local
to the GitHub app initially; extract a package or Worker when another consumer
or independent deployment gives that separation a concrete use.

## GitHub intake and authorization

1. Resolve the configured repository and require immutable ID `1043426082`.
   The verified canonical name is `OpenHands/software-agent-sdk`;
   `OpenHands/agent-sdk` is an alias.
2. Accept author IDs `6080905` (enyst) and `255025612` (smolpaws). Fetch source
   identity from GitHub metadata. Names in the body, `author_association` and
   unverified relay assertions cannot authorize work.
3. V1 uses repository-wide issue comments, including PR conversations, and
   inline PR review comments. Review summaries, issue/PR descriptions, commit
   comments and Discussions remain distinct, deferred intake surfaces.
4. Keep `@codex` and `@claude`. Parse case-insensitive tokens in authored Markdown,
   excluding fenced/inline code, blockquotes and URL destinations. Require handle
   boundaries so `@codex-example` does not match. Two real mentions create one
   request per provider.
5. Freeze the first qualifying observed body and revision hash. Other edits do
   not change the accepted prompt or launch another job. Before the first remote
   dispatch, re-fetch the source: deletion or removal of that provider's mention
   cancels it; an edit that retains the mention leaves the frozen prompt intact.
   The first observed snapshot may already contain edits made between polls.
6. Set an activation baseline and reject comments created before it. A new
   comment is a new request. Never replay historical requests automatically.
7. Exclude generated reply IDs and reserved output markers before routing,
   including replies as smolpaws. Preserve legitimate SmolPaws-authored requests;
   do not use a blanket author exclusion for this route.

Notifications are thread hints, not a per-comment event stream. The current
poller selects one candidate; that cannot guarantee every request between ticks.
Preserve repository feed pagination and cursors. A notification-based command
syntax would still need reliable source enumeration and activation policy.

## Authenticated direct intake

Expose a dedicated authenticated Worker interface for `ask_codex`, `ask_claude`
and request status. The SmolPaws tool adapter calls that interface; it does not
contain provider dispatch logic or provider keys.

- The service credential determines principal ID `255025612`. The payload cannot
  select enyst or another principal. Bind authorization to the allowed repository
  and permitted request/status operations.
- Require a stable client request ID, provider, repository ID and issue/PR reply
  destination. Validate the destination through GitHub metadata.
- Uniqueness is `(principal_id, client_request_id, provider)`. Include the complete
  request and destination in its digest; an identical retry returns the run,
  while changed content under the same key is a conflict.
- Apply the same admission budget, provider policy, context limits and reply
  outbox as GitHub intake. GitHub's comment-creation baseline applies to comments;
  direct admission is gated by its own activation switch.

Direct requests avoid a GitHub round trip. Public comment requests remain valid.
Read-only status exposes provider progress, failure reasons and action-required
states without leaking credentials, prompts or unrelated conversation content.

## Durable state and cron progression

Proposed D1 tables: `scan_state`, `intake_receipts`, `requests`, `reply_outbox`
and `generated_comments`. Add an admission budget bucket tied to each reservation.

- `scan_state`: completed cursor, in-progress scan start, validated next-page
  continuation and expiring lease, per repository/surface.
- `intake_receipts`: unique source/destination identity and pending handoff for
  both ordinary SmolPaws and hosted requests. Managed admission and its request
  row must be recorded atomically.
- `requests`: unique GitHub source/provider or direct principal/request/provider;
  frozen prompt/digest, policy version, target commit, lifecycle state, remote
  session ID, last event cursor, usage, stop reason, next attempt time and lease
  owner/version. One session per request in V1.
- `reply_outbox`: UNIQUE(run_key, reply_kind), desired payload/digest, publication
  lease, remote comment ID and delivery outcome.
- `generated_comments`: repository/comment IDs produced as replies by either
  controlled route, for shared loop exclusion.

Capture scan start time. Fetch with `since = last_completed_scan - 5 minutes`,
`sort=updated`, `direction=asc` and `per_page=100`. Follow every GitHub `Link` page.
Persist requests before advancing the completed cursor to scan start time.
Partial failures leave it unchanged. A page/tick cap saves a continuation for
the next tick rather than silently dropping remaining pages. Periodic wider
reconciliation repairs observations outside the overlap window. Polling cannot
observe a source deleted before any scan sees it.

D1 owns the managed lifecycle. The existing minute cron advances due rows;
there is no managed-job Queue or Cloudflare Workflow in V1. Each tick has a
bounded runtime, HTTP deadlines and bounded work. Provider execution continues
between ticks; a twenty-minute watchdog spans multiple invocations.

Use unique constraints, transactional admission/budget reservation and conditional
state updates with expiring leases and a version. A stale lease owner cannot
overwrite newer progress. If a dispatch/publication lease expires after a remote
mutation may have started, enter an unknown state and reconcile; do not simply
reopen the mutation. Keep any late acknowledgement tied to its owning request.

Proposed request states:

```text
accepted -> dispatching -> running -> result_ready -> publishing -> delivered
                         |           |
                         v           v
                  awaiting_action   stale_target

dispatching -> dispatch_unknown
publishing  -> delivery_unknown
any active state -> failed | canceled | budget_paused
```

Keep request state distinct from status-comment delivery. Posting a permission
or budget status does not make the agent's work successfully completed.

## Provider adapters and completion

Keep `preflight`, `start`, `observe`, `collectResult` and `cancel` inside each
adapter. The Worker calls the managed module's smaller interface. Vendor payloads,
beta headers, event names and sandbox configuration stay inside the adapters.

- OpenAI: Agents API, `POST /v1/agents/sessions`, `OpenAI-Beta: agents=v1`, hosted
  sandbox. Application key permissions include `api.agents.read`,
  `api.agents.write` and `api.responses.write`.
- Anthropic: Managed Agents with configured agent/environment IDs. Create at
  `POST /v1/sessions`, then submit a user event, or use `initial_events`.
  Use `anthropic-beta: managed-agents-2026-04-01` and the normal API version
  header. Set the session budget on creation.
- Pin models/configurations after account preflight. Do not silently substitute
  another provider. Use one session per request and serialize a thread/provider.

Poll session state and new events once per minute, storing event cursors and
current results in D1. Back off transient read failures and resume overdue rows
after a missed tick or restart. Idle alone is not completion: permission/input
waits and unfinished provider runs remain pending. Success requires the current
request's answer and a compatible completion reason.

Workflows and provider webhooks are deferred. There are no provider callback
endpoints or signature/event-webhook tables in V1. Add them only for a measured
need, with their verification and recovery requirements at that time.

Never assume creation/input submission supports an idempotency header. Verify
the live endpoint during preflight. Persist each acknowledged stage, including
the session ID before a separate user-event submission. Disable generic HTTP/SDK
retries around ambiguous non-idempotent mutations. Reconcile through documented
identifiers or metadata; when that cannot establish the result, require operator
action instead of another paid dispatch.

Known failures, permission waits and budget pauses get an attributed status
through the outbox. Expose dispatch/delivery unknown through the authenticated
status tool as action-required. While publication is unknown, reconcile its
receipt before making another GitHub mutation to announce that uncertainty.

## Context, credentials and publication policy

Keep the approved prompt separate from untrusted thread context. Label context
with authors and source links. Proposed limits are 16 KiB for an approved request,
twenty context comments and 32 KiB total context. Reject an oversized request;
truncate only context and make the truncation explicit. The original approved
request must remain present ahead of surrounding comments.

GitHub writing credentials belong to the router, not the sandbox or model.
Use smolpaws for ordinary replies. Its comment access grants no labeling or
maintainer authority. V1 needs no enyst write credential; later code publication
uses that separate credential under its own policy. Labeling and other maintainer
actions require separate authorization and the relevant repository permission.
Do not escalate a failed reply to enyst's credential.

Provision required keys and the direct-intake service credential into Worker
secrets when deploying. Keep them out of prompts, D1 payloads, logs, argv and
agent-visible files/environment. The SmolPaws tool runtime holds only its narrowly
scoped Worker credential, not hosted-provider or repository-maintainer keys.

Supply public code at a pinned commit through archives/input files or a public
clone without a writing credential. Configure sandbox networking and real SDK
test dependencies. GitHub mount/MCP integrations are optional; installing an app
on OpenHands must not become a prerequisite. Repository instructions and other
authors' comments cannot expand repository, credential or spending permissions.

## Delivery and later code proposals

Publish ordinary issue/PR replies as smolpaws. Put provider, configured model and
assessed commit SHA in the header, followed by the source request, findings and
actual test evidence. Direct requests use their run ID as the request reference.

Prepare the outbox before posting. Use a stable marker for each reply kind:

```html
<!-- github-mention-router:RUN_KEY:REPLY_KIND -->
```

After success, capture the remote comment ID and record it as a generated reply.
After a lost response, fully paginate the destination and reconcile the marker
under immutable writer ID `255025612`, holding the publication lease. Do not
blindly post again when absence is not conclusive. Suppress copied mentions.
An action status and a final outcome have different reply kinds and receipts;
update a known status comment rather than creating repeated status posts.

Later, explicit implementation requests can produce a pinned patch for a
deterministic proposal branch and draft PR using enyst's credential. Reject
forbidden paths under the initial policy and recheck target head/base. A fork PR
requires a writable fork branch or a new proposal branch in an allowed repository;
base-repository write access does not imply contributor-fork access. Reconcile
existing refs/PRs after lost responses. Default-branch pushes, merges and formal
approval/change-request verdicts remain outside the initial publication policy.

## Limits and acceptance evidence

Start with two concurrent jobs, one per thread/provider, twenty requests per day
and a twenty-minute watchdog. The example $20 daily admission budget limits new
work; it is not a guaranteed billing stop. Reserve it atomically and observe
usage. In-flight charges can overshoot; Claude's session cap can overshoot by an
in-flight model request. Verify OpenAI's controls independently.

Required implementation evidence:

- Hosted requests succeed with the local SmolPaws runner unavailable. Disabling
  managed routes preserves ordinary SmolPaws requests. Provider keys stay in
  controller configuration, out of request/status data and the local runner's
  payload. Personal state is not a module input.
- Legacy mention migration and durable pending queue receipts do not replay
  processed work or lose accepted sources during enqueue failures.
- Both GitHub feeds accept only allowed IDs and reject other authors, quotes,
  code, longer handles, historical sources and generated replies. Test two real
  provider mentions in one body and several requests between notification ticks.
- Direct authentication cannot be replaced by a payload principal. Same-key
  retries produce one run; changed content conflicts; destinations stay allowed.
- Pagination, equal timestamps, tick/page caps, delayed visibility, partial
  failures, concurrent scans and stale leases do not lose or duplicate requests.
- Crash injection covers admission/budget commit, acknowledged dispatch stages,
  remote creation/input acceptance and publication acknowledgement. Ambiguous
  mutation responses never become blind retries.
- Missed ticks and transient read failures recover the current result; permission
  waits, open provider runs and budget pauses never become success replies.
- Moving heads produce a clearly stale result or a fresh assessment. Headers
  carry the assessed SHA. Context limits preserve the trusted request.
- A controlled fixture proves both APIs, actual costs/dependencies, one current
  outcome per request, visible failures, restored state and no output loop.
- Intake, direct intake, each provider and publication have independent switches;
  the watchdog can cancel work and retain actionable status.

## Rollout and work ownership

1. Wire the isolated module in shadow mode and prove intake, migration, direct
   authorization, bounded progression and separation from the local runner.
2. Prove provider account access, execution, publication and failure recovery
   together on a controlled public fixture.
3. Set the target baseline and enable bounded replies, verifying ordinary
   SmolPaws requests alongside the managed routes.

Branches/draft PRs, review summaries and thread session continuation are later
phases. Transfer this contract, the example configuration and pending Beads work
to the GitHub app/SmolPaws tracker when implementation starts. Record cross-links
and handoff status in this draft tracker so there is one active implementation
owner, and preserve the draft history.
