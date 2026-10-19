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
