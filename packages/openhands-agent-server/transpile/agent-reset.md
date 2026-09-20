# Agent-controlled condensation integration

Date: 2026-09-20. Local server integration verification and independent review are complete; PR review and merge remain the next gate.

The vendored SDK comes from reviewed/merged
[SDK PR #51](https://github.com/smolpaws/openhands-agent/pull/51), exact source commit
`5c204c57377a8001653615f4000c3ce9534a1111`. The canonical Python pin in
`vendor/openhands-agent/transpile/upstream.json` is unchanged. No moving Python HEAD
or unrelated open PR was incorporated.

## Classification

SDK EXT-SDK-004 and DEV-SDK-012 define the new opt-in behavior. Server
[DEV-SERVER-010](../TRANSPILE_RULES.md#dev-server-010--opt-in-agent-controlled-condensation)
covers the deliberately different host-maintenance response and separate hard binding.
The pinned Python `conversation_router.py` and `event_service.py` expose host
condensation through the configured ordinary condenser; they have no equivalent
agent-reset mode. Existing standard-mode tests remain the compatibility oracle.

The server delegates execution, View replay, warning counts, tool schemas and
per-attempt accounting to the SDK. It owns independent profile/settings capture,
public-field stripping, metadata leases, profile-switch preservation and HTTP/OpenAPI
mapping. Product relay code owns the fixed receipt and durable delivery transaction.

## Evidence map

- `src/__tests__/hardCondenserProfiles.test.ts`: independent profile-free/reset and
  explicit hard binding, guarded capture, restore/fork and switching constraints.
- `src/__tests__/agentResetWorkflow.test.ts`: protected real-server workflows with
  mocked provider responses, concurrent input, persistence and accounting.
- `src/__tests__/condense.test.ts`: manual 409/type preservation/preparation guard,
  with existing standard success/error/auth/lease/publication regressions.
- Product scheduled-agent and condenser workflows: intrinsic tool composition,
  scope/context preservation and relay receipt behavior.
- Generated OpenAPI plus `transpile/openapi-policy.json`: exact existing-route
  exception for the new mode, tied to the registered server policy.

RED tests reproduced the old generic 500 for the new SDK error, unwanted summary
preparation for stored reset mode, auxiliary role lookup in profile-free mode, and
public acceptance of forged hard bindings. The corresponding GREEN tests now pass.

## Verification on 2026-09-20

- Complete server `npm run ci` passes: 218 tests (also under coverage), provenance,
  all interval review records, generated OpenAPI parity, credential-free local
  endpoint smoke, source/example typechecks, lint, builds and packed-consumer smoke.
- Root and relay-server typechecks pass. All 110 coordinator tests and 62 product
  relay-server tests pass.
- Protected HTTP/WebSocket workflows cover exact reset ordering, late input,
  restart/fork, independent hard snapshots, actual overflow fallback and accounting,
  main-profile warning budgets, and interrupted voluntary results without replay.
- A real-server relay test verifies one fixed unsupported-mode receipt across an
  actual SQLite reopen, no duplicate POST/reset/main call, and subsequent chatting.
  Scheduled agents receive exactly one intrinsic condense tool only in reset mode.
- Independent server, relay and configuration/documentation reviews found no
  blocking issue. The rollout instructions distinguish reset-only verification
  from summary-mode verification; no auxiliary profile is required for reset-only.

PR review and current-commit CI remain merge gates. No live LLM charge, service
restart, runtime configuration update or deployment is claimed here.
