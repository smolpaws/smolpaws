# GitHub webhook relay

GitHub → signature/allowlist checks in `apps/github` → Cloudflare Queue → authenticated product
host intake → Message Relay SQLite → agent-server → delivery outbox → GitHub comment.

The Worker sends `POST /api/bridges/github/messages` to `SMOLPAWS_RELAY_SERVER_URL` with
`X-Session-API-Key: SMOLPAWS_RELAY_SERVER_API_KEY`. It acknowledges work only after a 202 durable
acceptance receipt. Missing configuration is an error, not a fake agent reply.

Start the product host with `npm run relay-server:start` (default `http://127.0.0.1:8790`).
The host must have a session key (`OPENHANDS_SESSION_API_KEY` or `SESSION_API_KEY`) and GitHub
delivery credentials. Notification replies use `GITHUB_USER_TOKEN`; installation replies use
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. Never send those credentials in intake messages.

Conversation lanes are credential identity + repository + issue/PR number. Existing checkouts under `SMOLPAWS_WORKSPACE_ROOT` are selected by repository name or the private
`SMOLPAWS_REPO_MAP_PATH` mapping; paths and symlinks outside that root are rejected.
Repeated delivery identities do not append a
second user event. Delivery is independent of the Worker request lifetime and survives host restarts.
An ambiguous GitHub send stays `delivery_unknown` for operator reconciliation.

Workers remain dormant until explicitly configured and deployed. See [app instructions](../../apps/github/AGENTS.md),
[shared bridge architecture](../bridges.md), and [runtime tests](../agent-server-testing.md).
