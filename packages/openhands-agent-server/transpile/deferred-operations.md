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

Bead `smolpaws-09ou` explicitly tracks new conversation-scoped runtime, file/git/bash and VSCode operations in the reviewed intervals. Each has its own policy entry; this is an explicit expansion. Profile secret authorization, local runtime_info/persisted reads, Docker lifecycle and search-limit422 validation remain documented in the interval records.
