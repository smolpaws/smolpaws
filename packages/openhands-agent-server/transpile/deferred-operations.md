# Deferred pinned OpenAPI operations

Tracking ID: `OPENAPI-DEFERRED-001`

This is the work item for upstream agent-server operations that are present in the canonical pinned Python OpenAPI but not yet implemented by the TypeScript server and not covered by a permanent `DEV-*` or `EXC-*` policy.

The exact mechanical inventory lives in [`openapi-policy.json`](openapi-policy.json). Do not duplicate the route list here; the comparator checks that the policy contains neither missing nor stale entries.

For each deferred operation, eventually do one of:

1. port the upstream tests and behavior red/green, then remove the exception;
2. replace the temporary deferral with a reviewed permanent policy ID; or
3. remove the exception when a later pinned upstream version removes the operation.

A deferred operation must remain visible in generated parity output. This file is not permission to broaden the deferral to newly discovered routes.

## Bounded runtime expansion

Bead `smolpaws-09ou` explicitly tracks new conversation-scoped runtime, file/git/bash and VSCode operations in the reviewed intervals. Each has its own policy entry; this is an explicit expansion. Profile secret metadata filtering is now ported; see [secret scoping correction](secret-scoping.md). Local runtime_info/persisted reads, Docker lifecycle and search-limit422 validation remain documented in the interval records.

The `d128a786..e7cc8c27` interval also carries runtime work that a route inventory
alone cannot express. Docker launches need the upstream host-gateway mapping.
MCP OAuth tool construction must seed inline credentials when no saved server
matches, retain refreshed/deleted inline state in memory, and give saved settings
precedence. That behavior remains under `OPENAPI-DEFERRED-001`; storing MCP
configuration metadata does not implement it.

General `LookupSecret` URL hydration and local resolver registration remain
deferred with SDK `openhands-agent-wlw.6` and server `smolpaws-09ou`. Existing native
profile keys resolve directly through asynchronous `SecretStore` references and
secret GET responses remain redacted. The persistence deviation does not exclude
the missing runtime protocol. Revisit these semantics with conversation secret
injection and profile authorization, preserving the no-raw-persistence boundary.

## Bounded v1.50.0 lifecycle expansion

The `e7cc8c27..dcf401af` review explicitly adds six Canvas backend operations to
`OPENAPI-DEFERRED-001`, individually listed in the policy. This depends on the
already deferred Canvas manifest/install subsystem. Preparation and start must
use the exact installed revision, verify checksums, and safely extract immutable
artifacts with archive/path containment. Executables must remain contained and
receive a sanitized child environment. Readiness and unsupported-platform states,
concurrent/idempotent starts, and cancellation of hung startup are part of this
work. Stop, disable, uninstall and server shutdown must clean up process groups
and descendants. Uninstall retains backend data; explicit data deletion requires
a stopped backend. Log tails default to 65,536 bytes and accept 1 through 262,144.
Forced install must reject with 409 while a backend is running. These requirements
include changes to existing install routes, beyond the six new operations.

The same interval extends the existing Docker runtime debt (`smolpaws-09ou`) with
idle eviction: running conversations and active HTTP/WebSocket proxy attachments
prevent eviction, detachment refreshes the deadline, shutdown cancels the sweeper,
and a failed stop restores the container to the registry. The native lease is not
an implementation of this Docker lifecycle.

MCP OAuth debt also includes best-effort inline refreshed-state writeback webhooks,
retaining new state in memory on webhook failure. Settings-backed state does not
use that webhook. Session auth headers and immediate successful OAuth start when
stored/refreshed credentials need no browser consent remain deferred. SDK secret
hydration debt also includes masking resolved values in observations; redacted
metadata alone does not provide that behavior.

Server LLM title generation and its conversation-owned call context are tracked
separately as `openhands-agent-wlw.10`. The current title remains a deterministic
text fallback. Passing durable conversation IDs into main, condenser and classifier
calls does not close the missing title model call, reasoning cleanup, or its
fallback/error behavior. Revisit with the upstream title utility and tests.

## Bounded v1.52.0 lifecycle expansion

The `dcf401af..229b2b92` interval keeps five units explicitly deferred. Canvas
backend authentication now includes sessions, HTTP/WebSocket ingress proxying,
revocation and capability reporting under `OPENAPI-DEFERRED-001`. Some ingress
routes are outside `/api`; absence from the operation comparator does not mean
that they are implemented. Revisit with the authenticated Canvas backend runtime
and its source security tests.

Docker idle eviction must refresh the persistent conversation catalog after the
container stops. Standalone VSCode shutdown must terminate its owned process group
and release the listening port. Both remain in `smolpaws-09ou`; the permanent
native initialization difference does not exclude the VSCode lifecycle fix.
The new conversation-runtime-scoped Bash stop operation is individually deferred
there too. The global native Bash stop operation is implemented and tested.

Provider-connection credential/base-URL resolution and upstream `/switch_llm`
remain deferred under `OPENAPI-DEFERRED-001`. Missing/dangling connections must
fail 422 before replacing a working model. Native saved-profile switching does
not close that missing compatibility route. Delegated child execution and its
new tool/MCP confinement scope remain tracked with SDK `openhands-agent-wlw.8`
and `.14`. Revisit both when their runtime prerequisites are implemented,
carrying the source regression cases before claiming parity.

## Bounded v1.55.0 lifecycle expansion

The `229b2b92..fd387b58` record keeps missing runtimes visible even where a local
counterpart is now ported. Active-profile seeding, launch overrides, additional
skills and public selection work in native launch/materialization. The missing
OpenAI-compatible `/v1` gateway and Docker forwarding still need those semantics;
`OPENAPI-DEFERRED-001` covers them even though the comparator scans `/api` only.
The global upload path now returns 400 for directory/parent-file conflicts; its
conversation-runtime mirror remains deferred. Read-only subagent metadata does
not implement delegated child execution or exact inherited MCP confinement.

Canvas debt now includes contained manifest-declared SVG icons with the required
headers, requested versus resolved references, checksum-pinned remote backend
artifacts, descendant/orphan reaping, missed-health re-probes, root query forwarding,
crashed-backend refusal and proxy body framing/trust/IPv6 cookie behavior. Docker
debt includes owned cache reclamation, disabled core dumps, stopped-workspace disk
budgets, durable archival markers and a real storage-reclaim scenario. These all
require their actual runtime owner and source regressions before closure.

Bead `smolpaws-09ou` also carries trajectory ZIP exclusion of credential/transient
files, races with state saves and exact inspected JSON bytes; managed-worktree
last-reference cleanup, symlink refusal and retained branches; and live-process
plus token gating of VSCode URLs. Provider-connection plaintext reads remain
subject to the secret-storage deviation and missing connection resolution.

Skills discovery/sync and local installed refresh are ported. Generic remote
extension installation/refresh remains SDK `openhands-agent-wlw.19`; effective
organization and registered-marketplace loading requires a host adapter and
returns explicit unsupported errors when requested without one. Full project
skill discovery, critic activation and `invoke_skill` remain `.15`. A successful
catalog response or local refresh does not close these runtime gaps.
