# Deferred pinned OpenAPI operations

Tracking ID: `OPENAPI-DEFERRED-001`

This is the work item for upstream agent-server operations that are present in the canonical pinned Python OpenAPI but not yet implemented by the TypeScript server and not covered by a permanent `DEV-*` or `EXC-*` policy.

The exact mechanical inventory lives in [`openapi-policy.json`](openapi-policy.json). Do not duplicate the route list here; the comparator checks that the policy contains neither missing nor stale entries.

For each deferred operation, eventually do one of:

1. port the upstream tests and behavior red/green, then remove the exception;
2. replace the temporary deferral with a reviewed permanent policy ID; or
3. remove the exception when a later pinned upstream version removes the operation.

A deferred operation must remain visible in generated parity output. This file is not permission to broaden the deferral to newly discovered routes.
