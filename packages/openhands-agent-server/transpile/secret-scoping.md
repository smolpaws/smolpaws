# Profile-scoped secret metadata lookup

2026-10-04: completes the deferred `bd88f050259276978dc31541d8099d98e4994428:server` unit from `481dfb3d..d128a786`, tracked within `smolpaws-09ou`. The merged interval review remains frozen; this correction supersedes its secret-lookup deferral.

`GET /api/settings/secrets?agent_profile_id=…` resolves a saved profile by ID, filters secret metadata by its `secret_refs`, and returns 404 for an unknown profile. Omitted IDs and null `secret_refs` preserve the unfiltered list; an empty allow-list returns no secrets. This matches the pinned Python `settings_router.list_secrets`; it does not change secret storage or return raw secret values.

Evidence: `src/__tests__/secretScoping.test.ts`, adapted against the real Fastify app, fails on main because both secret names are returned for a one-name profile. The port makes it pass. The generated OpenAPI documents the optional query and 404, and the corresponding shared-contract deferral is removed. Other compatibility debt under `smolpaws-09ou` remains open.
