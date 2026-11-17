# GitHub deployment boundary

The Cloudflare Worker handles webhook verification, notification polling and its ingress queue.
The product host (`apps/relay-server`) needs persistent disk for agent conversations, relay SQLite
and scheduler state. It must be reachable by the Worker through an authenticated HTTPS endpoint.

The current host is local. Remote placement requires a separate deployment decision and must retain
that persistence and the product composition; pointing at a bare Python/TypeScript agent-server is
insufficient because `/api/bridges/github/messages` is product-owned.
