# @smolpaws/openhands-agent-server

Idiomatic TypeScript transpilation of the OpenHands Python
[`openhands-agent-server`](https://github.com/OpenHands/software-agent-sdk) package —
the REST/WebSocket server layer that sits on top of the SDK.

## Status

**Empty scaffold — transpilation not started.** This directory is the agreed home for the
fresh TypeScript transpile of the upstream agent-server. It is the server-layer sibling to
[`@smolpaws/openhands-agent`](https://github.com/smolpaws/openhands-agent) (the SDK transpile),
which deliberately shipped only the client side of the server boundary
(`RemoteConversation`/`RemoteWorkspace`) and left the server itself unported.

## Provenance

- **Source:** `openhands-agent-server` in the Python `agent-sdk`.
- **Pinned base commit:** `966340979be26c2162e9ab8805557b715e1f1a78`
  (same commit the SDK transpile was cut from — keep both in lockstep).
- **Local Python source:** `~/repos/agent-sdk/openhands-agent-server/openhands/agent_server/`.

## References the transpile should follow

1. **Upstream Python** (the thing to transpile), at the pinned commit above.
2. **The SDK transpile** [`@smolpaws/openhands-agent`](https://github.com/smolpaws/openhands-agent)
   (`~/repos/openhands-agent`) — same tooling/test conventions (tsup, vitest, eslint type-checked,
   zod v4), same "idiomatic, not line-by-line" philosophy, same secret model (keyring-backed
   `SecretStore`). This package depends on it.
3. **Our current bespoke server** `~/repos/smolpaws/apps/agent-server` — the server SmolPaws
   actually runs today. Not the port target, but the reference for what SmolPaws needs in
   practice, and the source of our biggest drift from upstream: **turns as a first-class
   concept** (see `docs/smolpaws-sdk-swap` / the migration plan). The transpile targets the
   upstream `/events` + `/run` contract, not our `/turns` contract.

## Open architectural question this unblocks

How to implement proper **message queueing** on the upstream agent-server REST API — the thing
"turns" gave us (exactly-once delivery, idempotency, ordering) — without reintroducing turns.
See the migration plan for context.
