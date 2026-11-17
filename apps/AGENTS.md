# Bridge apps

WhatsApp, Slack and Discord are standalone socket bridges. Each owns its platform connection,
normalizes trusted messages, and uses `src/coordinator/relayRuntime.ts` for durable intake and delivery.
Start them with `scripts/run-local-bridge.sh <name>`; `plugin.json` must declare `kind: standalone`.

GitHub and email are Cloudflare webhook Workers. They verify signature/allowlist/authentication,
queue inbound work, then forward it to authenticated `POST /api/bridges/{platform}/messages` on
`apps/relay-server`. A 202 receipt means the host committed intake; the Worker does not wait for
an agent answer or send it. The host's per-platform relay and DeliveryTarget own outbound replies.

The six bridge responsibilities are users, channels, messages, platform events, sending and receiving.
Queue claims, retries, deduplication and delivery uncertainty stay in `src/coordinator/`.
Shared conversation defaults live in `src/shared/relayConversationDefaults.ts`.

`packages/openhands-agent-server` owns the upstream-shaped API. `apps/relay-server` adds product
context/tools, heartbeat and webhook intake. The legacy runner, `/turns`, bridge loader and rollback
root process are retired. Do not restore them as compatibility fallbacks.
