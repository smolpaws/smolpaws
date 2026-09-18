# Standard condensation

Implementation date: 2026-09-18. This documents the new TypeScript Agent Server and
shared WhatsApp/Slack relay. Deployment and service restart are separate operations.

The canonical SDK implements the pinned Python condensation mechanism. SmolPaws
selects its profile, exposes the API and dispatches channel commands. The durable
EventLog stays append-only: condensation records which events to omit from later
model views and inserts a summary into that view.

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

## What triggers condensation

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

Before an authorized rollout, select and validate condenser profiles for the
intended scopes, build from the reviewed server commit, and verify its SDK package
provenance. Use an isolated conversation to check the selected profile, a summary,
continued work and usage after restore. Wait for active steps before a normal
service handoff and preserve conversation/relay state for rollback. This change
itself does not restart a bridge or server. Fast-Jev evaluation remains later work.
