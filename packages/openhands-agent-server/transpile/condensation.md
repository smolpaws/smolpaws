# Standard condensation integration

Date: 2026-09-18. This closes an existing gap at the unchanged canonical Python pin
in `vendor/openhands-agent/transpile/upstream.json`. The packed SDK source is the
reviewed merge of [SDK #46](https://github.com/smolpaws/openhands-agent/pull/46),
recorded in the vendored package provenance. This is not a pin advance; historical
interval reviews remain frozen. Tracking: `smolpaws-iizg.8` through `.10` and
`smolpaws-xtv.3`.

## Bounded source map

| Pinned Python source/behavior | Target and evidence | Disposition |
| --- | --- | --- |
| `conversation_router.py::condense_conversation` → `conversation_service.py::condense` → `event_service.py::condense` | `conversationRouter.ts`, `EventService.condense`; `condense.test.ts` | PORT: 200 success, 404 missing, rejected unsupported condenser; delegate to SDK |
| SDK `LocalConversation.condense` step serialization, explicit request and error behavior | Vendored SDK; server running-step, initial-construction, pause, input and failure tests | PORT with existing SDK EXT-SDK-003 and server ownership policy |
| Python settings/LLM summarizer construction | `condenserBinding.ts`, profile factory; `condenserProfiles.test.ts`, `condenserProfileWorkflow.test.ts` | DEV-SERVER-004 / DEV-SDK-004: independently selected saved profile, immutable secret-free binding |
| Python `Condensation.model_dump(mode="json")` forgotten-ID arrays | `eventWire.ts`, REST and both sockets; `condensationWire.test.ts` | PORT: fixture derived from the pinned Python EventLog oracle |
| Python summary completion accounting | SDK usage events exposed through existing server statistics and restore/fork | DEV-SDK-007 / DEV-SERVER-007: explicit unknowns and actual profile/model |
| Channel command recognition, durable attempt/outcome/receipt | Shared coordinator and WhatsApp/Slack tests | SmolPaws product behavior, outside Python transpilation |

Python server paths are under `openhands-agent-server/openhands/agent_server/`.
The SDK source mapping, original View/condenser tests, c01-c05 integration cases,
provider classifiers and tokenizer limits are in its
[condensation evidence](https://github.com/smolpaws/openhands-agent/blob/main/transpile/condensation.md).
The initial plan incorrectly said c02 was absent; pinned source inspection confirmed
`c02_hard_context_reset.py` exists and the SDK maps that case.

## Ownership and failure behavior

The server creates no second View, summary prompt, cut algorithm or token counter.
Normal steps and the manual API use the same cached SDK conversation and step guard.
Manual operation promises cover construction, completion, metadata and publication;
close/delete waits before releasing ownership. Partial durable events, including
failed-attempt usage, are published once. Manual failure rejects with sanitized
details and preserves the existing execution state; it does not become an ordinary
run or consume the last-user-input marker.

The first enabled use captures a profile and effective condenser settings. Role,
catalog, client and runtime-metadata work happens outside the lease lock. A guarded
recheck captures the immutable binding before summary calls. Subsequent main-model
switches, catalog edits/deletion and restart cannot silently replace that binding.
A fork after capture inherits it; a fork before capture resolves independently on
first use. For legacy metadata without agent settings, first condenser capture atomically
pins the validated server defaults with its binding; later default edits cannot rewrite
that selection. HTTP creation strips forged binding fields. Disabled/no-op settings
perform no condenser credential lookup. An enabled but unconfigured summarizer
fails clearly; unrelated tests/examples explicitly disable it instead of relying
on the previous ignored setting.

The product host resolves explicit settings first, then the trusted registered
scope's condenser role, then the global role. Scheduled-helper profile, tools and
context isolation remain intact. `/condense` recognition occurs only at authorized
ingress before transcript enrichment. Its durable coordinator journal fences the
single non-idempotent POST, then records an outcome and unique receipt atomically.
Uncertain outcomes are never automatically retried. This does not extend the
upstream API or move queue semantics into the server.

## Evidence and reproduction

Tests were written first: the route returned 501 before the implementation; new
profile cases failed before condenser materialization; five REST/socket wire cases
returned `{}` instead of Python ID arrays. Those focused suites now pass. Product
tests similarly exposed missing command dispatch before implementation and cover
real SQLite, protected HTTP, bridge parsing, lost responses, deadlines and restart.

Run the package's full required gate from `packages/openhands-agent-server`:

```sh
npm run ci
```

Run root coordinator/product regressions and the standalone Slack/WhatsApp suites,
including scheduled helpers, then root and bridge typechecks. Regenerate OpenAPI
with `scripts/generate-openapi.sh`; verify provenance, shared-pin server reviews,
OpenAPI parity and packed-consumer behavior. The vendoring script now refreshes the
lock for changed file-package dependencies before `npm ci`, including the SDK's
local tokenizer dependency.

The SDK's explicitly authorized DeepSeek forced-condensation smoke passed (nine
requests, two summaries, continued tools and restored usage). Server/product tests
use deterministic providers and isolated temporary state. No production service
restart or hosted rollout is part of this implementation. See the
[product guide](../../../docs/condensation.md) for configuration and later rollout.
