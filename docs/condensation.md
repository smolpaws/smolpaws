# Condensation

Standard implementation: 2026-09-18. Agent-controlled mode: 2026-09-20. This documents the new TypeScript Agent Server and
shared WhatsApp/Slack relay. Deployment and service restart are separate operations.

The canonical SDK implements the pinned Python condensation mechanism. SmolPaws
selects its profile, exposes the API and dispatches channel commands. The durable
EventLog stays append-only: condensation records which events to omit from later
model views and inserts a summary or the validated agent-controlled reset sequence.
The following standard-mode settings remain the default; agent-controlled mode is opt-in.

## Configure the condenser

Save a suitable LLM profile on the server, including its usual secret references.
Select it explicitly in `agent_settings.condenser.llm_profile_ref`, or configure the
product server's `models.json` role:

```json
{
  "version": 1,
  "roles": { "condenser": "my-summary-profile" },
  "scopes": { "whatsapp:main": { "condenser": "my-main-summary-profile" } }
}
```

An explicit condenser reference wins, followed by the registered scope selection
and the shared role. The main agent's profile is never an implicit fallback.
Scheduled helpers keep their own main profile, exact tools and context; the
condenser role still uses their registered scope. HTTP tags cannot grant another
scope's configuration.

The first run or manual condensation freezes the selected profile and effective
settings in the conversation's private metadata. Restarts, main-profile switches
and forks after capture keep that binding. A fork before capture selects on its
own first use. Older metadata without embedded agent settings captures its effective
server defaults with the binding. Catalog, role, or server-default edits alone do not
rebind an existing condenser.

Settings, the SDK class, and `defaultCondenser()` share `max_size: 1000` and
`keep_first: 2`. This deliberate difference from pinned Python defaults is registered
as `DEV-SDK-011`; explicitly saved limits remain unchanged. The token cap is inherited
from the initial main client when available. An explicitly supplied condenser
`max_tokens` is honored; the active main input limit can further lower the effective cap.

These token fields have different purposes:

- A saved LLM profile's `maxInputTokens` declares that client's input budget. The
  main client's effective budget participates in condensation thresholds and cuts.
- `agent_settings.condenser.max_tokens` sets the threshold for condensing the main
  conversation's estimated input. It does not set the summarizer's input capacity.
- A profile's `maxOutputTokens` requests an output-token budget through the provider adapter.

For example, a 400,000-token condensation threshold is `max_tokens: 400000` in
condenser settings. A 400,000-token client input budget is `maxInputTokens: 400000`
in its saved profile. Numeric budgets belong in these settings/profiles, while
`models.json` selects profiles by name.
The provider adapters do not enforce this budget as a hard request-size limit, and
the summarizer does not separately check its own profile's input budget before sending
a summary prompt. Setting only the condenser profile's `maxInputTokens` therefore
does not establish a 400,000-token main-context trigger; configure the main profile
or the condenser setting for that purpose.

Previously, an enabled-looking condenser setting was ignored. It is now active and
requires a valid condenser profile on first use. Configure it before rollout, or
explicitly set `enabled: false` / choose `no_op` where condensation is unwanted.
These cases do not look up condenser credentials. The implementation creates no
profiles and changes no running deployment settings automatically.

## What triggers standard condensation

- Event pressure: the retained model View exceeds `max_size`. This is a soft request;
  if there is no safe cut that makes enough progress, a later step tries again.
- Token pressure: the estimated full input, including fixed context and tools,
  exceeds the effective input cap. This is a hard request.
- Provider failure: a recognized input-context overflow or malformed tool history
  appends a condensation request. Another step condenses before main execution
  continues. Authentication, rate limits, output exhaustion and generic HTTP
  400/413 failures do not automatically qualify.
- Explicit command/API request: a hard maintenance request, serialized with normal
  model/tool steps. It preserves paused or finished state and does not answer or
  discard queued user input.

Cuts preserve complete tool batches, call/result pairs and thinking loops. Hard
requests can fall back to summarizing the whole retained View, dropping keep-first
protection. Hard reset has five total attempts with progressively shortened event
previews. A soft delay is not a detached background summarizer.

There is no raw event-byte-size threshold. A large observation can trigger token
pressure or provider recovery. Counts are estimates; unsupported modalities can
make them unavailable. Full host context remains present, so condensation cannot
repair a fixed system/context prompt that already exceeds the model's window.

Each summary attempt records the actual condenser profile and reported usage under
`condenser`. Unknown counters/costs stay unknown. Failed metadata persistence does
not silently repeat a paid summary. Source differences and tokenizer limits are
in the [SDK evidence](https://github.com/smolpaws/openhands-agent/blob/main/transpile/condensation.md).

## Agent-controlled mode

Save the main and optional emergency profiles, then select these agent settings for
new conversations (or an explicitly managed migration):

```json
{
  "llm_profile_ref": "main",
  "condenser": {
    "condenser_kind": "agent_reset",
    "warning_thresholds": [0.75, 0.80, 0.85, 0.90]
  },
  "hard_condenser": {
    "condenser_kind": "llm_summarizing",
    "llm_profile_ref": "my-summary-profile"
  }
}
```

Omit `hard_condenser` or set it to null for reset-only operation; no summarizer
profile or credentials are then resolved. The ordinary `models.json` condenser role
does not implicitly enable the emergency fallback. When configured, its own profile
and settings are captured separately before agent execution, preserved across
restart, forks after capture and main-model changes. Catalog edits do not rebind it.
Advanced fallback settings are `hard_context_reset_max_retries` (default 5) and
`hard_context_reset_context_scaling` (default 0.8); there are no keep-first or
proactive event/token triggers on this fallback.

The active main profile's `maxInputTokens`, when set, is the warning denominator.
With 400,000 input tokens, the defaults warn at 300,000, 320,000, 340,000 and
360,000. Otherwise, resolved main-model metadata may supply the limit. Estimates
include fixed system context, memory/skills snapshots and tools; unknown counts or
limits stay unknown. Warnings are advisory even above 100%, and only committed
condensation rearms them. Event counts, elapsed turns and ignored warnings never
force a reset or block a main request in this mode.

The SDK supplies `condense(message_to_future_self?)` automatically; do not add it
to the ordinary tool-name list. The agent decides when to save notes using its
existing tools, then calls condense alone in a response. The optional message is
preserved verbatim, up to 16,384 UTF-16 code units. Reset performs no summarizer call
and no memory-file write. After normal fixed context, the next request contains the
environment notice “The agent triggered context condensation.”, the genuine tool
call/result with recovery guidance, and user input that arrived too late for the
agent to have seen. The complete durable log and usage remain available. Host memory
stays a snapshot; the agent reads its newly written notes to regain its bearings.

Only a recognized main-provider context-window error invokes the configured hard
fallback. It summarizes eligible old history using the SDK's existing full-view
algorithm, places an honest environment notice before the generated summary, and
preserves unconsumed/rejected-request input and later arrivals. It has no fabricated
tool pair. Missing fallback, failed/exhausted summary or repeated rejection stops
with history retained. An interrupted or failed hard attempt is not automatically
paid for again until a subsequent main request succeeds. Per-attempt usage remains
in the existing `condenser` group. This is a direct error fallback, not a pipeline.

In this mode, `/condense` returns a clear rejection telling you to ask the agent to
save notes and call its tool. The HTTP response is 409 with code
`agent_controlled_condensation`; it does not force a summarizer call. Ordinary
summarizer-mode commands keep the behavior below. Deployment and per-conversation
opt-in remain separate from installing this implementation.

## Manual requests and receipts

Send an exact `/condense` through an authorized WhatsApp or Slack ingress. Existing
allowlists and mention/trigger rules still apply. Commands are recognized before
thread/transcript context is assembled; a quoted example or embedded occurrence
remains ordinary text. The command targets only its registered conversation and
uses the backend session key. It adds no ordinary user prompt and starts no extra
agent run.

The relay records command identity and a send-attempt fence durably. It emits one
durable success, failure or unconfirmed-outcome receipt. A lost response or process
interruption after sending is not automatically retried: the summary might already
have completed. A fresh user command is a separate explicit attempt. Subsequent
ordinary messages can proceed after the command's outcome is settled. Receipt
sending uses the existing delivery dispatcher and its recovery rules.

Direct callers use `POST /api/conversations/{conversation_id}/condense` with the
normal `X-Session-API-Key` header. Success is HTTP 200 with `{ "success": true }`;
a missing conversation is 404. A missing/unsupported condenser or failed summary
returns an error. The bare API has no idempotency key; clients must not blindly
retry an uncertain POST.

## Later rollout

Before an authorized rollout, choose the intended mode and scope, build from the
reviewed server commit, and verify its SDK provenance. In an isolated conversation,
verify either a standard summary or the genuine agent-controlled tool/reset sequence,
then continued work and usage after restore. Reset-only needs no auxiliary profile;
select and validate one only for ordinary summarization or the explicit hard fallback.
Any live fallback check needs its own bounded provider-call authorization.
Wait for active steps before a normal service handoff and preserve conversation/relay
state for rollback. This change itself does not restart a bridge or server.
Fast-Jev evaluation remains later work.
