# @smolpaws/openhands-agent-server

Idiomatic TypeScript transpilation of the OpenHands Python
[`openhands-agent-server`](https://github.com/OpenHands/software-agent-sdk) package —
the REST/WebSocket server layer that sits on top of the SDK.

## Status

**Validated TypeScript parity slice.** This package now contains the upstream-shaped
Fastify REST/WebSocket server for the implemented conversation, event, pub/sub,
settings/profile/skills, persistence, secret, lease, and OpenAPI surfaces. It is the server-layer sibling to
[`@smolpaws/openhands-agent`](https://github.com/smolpaws/openhands-agent) (the SDK transpile),
which deliberately shipped only the client side of the server boundary
(`RemoteConversation`/`RemoteWorkspace`) and left the server itself unported.

Implemented in this slice:

- `/alive`, `/health`, `/ready`, `/server_info`, `/openapi.json`
- `/api/conversations` search/count/batch/start/get/update/delete
- upstream `/run`, `/pause`, `/interrupt`, `/agent_final_response`, `/fork`
- `/api/conversations/{conversation_id}/events` search/count/batch/get/post
- `/sockets/events/{conversation_id}` event streaming with replay modes
- bash command/event routes and `/sockets/bash-events`
- git changes/diff routes
- file home/search/download/upload routes
- SDK `EventLog` durability with server-owned, lease-guarded `meta.json`
- per-conversation lease ownership safeguards for multi-instance/restart overlap
- settings, profiles, agent-profiles, skills, and keychain-backed secret metadata routes
- settings-backed agent creation from the active LLM profile, with per-conversation profile and iteration-limit snapshots
- keychain-backed conversation secret flows without plaintext metadata/event persistence
- zod-backed contracts, tsup/vitest/type-checked eslint, coverage, strict example typechecking, OpenAPI CLI generation, route-parity checks, and packed-consumer smoke testing
- credential-free local endpoint smoke workflow (`npm run smoke:local`) covering the real Fastify REST/WebSocket surface without `RemoteConversation`/`RemoteWorkspace`
- package-local profile-driven LLM workflow (`npm run manual:llm` with `OPENAI_API_KEY`)

Required next parity work:

- deeper live-agent parity runs against additional providers/models
- the future message-queue layer that replaces SmolPaws turns

Intentionally not wanted in this package:

- ACP runtime/model switching
- security analyzers / risk scoring
- confirmation mode, confirmation policy, confirmation gates, and confirmation replies
- deferred init

Genuinely deferred / useful later:

- file trajectory download
- OpenAI-compatible `/v1/*` gateway
- VS Code and desktop routes
- auth cookie routes
- MCP test route
- workspace routers

## Provenance

- **Source:** `openhands-agent-server` in the Python `agent-sdk`.
- **Pinned base commit:** `966340979be26c2162e9ab8805557b715e1f1a78`
  (same commit the SDK transpile was cut from — keep both in lockstep).
- **Local Python source:** `~/repos/agent-sdk/openhands-agent-server/openhands/agent_server/`.

## Architecture and criteria

See [`TRANSPILE_RULES.md`](TRANSPILE_RULES.md) for durable porting rules
(secrets, LLM profiles, route-family scope, tests, and OpenAPI) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the first-slice architecture,
fulfilled criteria, accepted deviations, persistence ownership, and next parity
checklist.

Package-local validation:

```sh
npm run ci
```

The package CI includes strict source and example typechecks, a `npm pack --dry-run`, real tarball pack, throwaway consumer install, TypeScript import check, runtime import smoke through `npm run test:pack`, and the credential-free local endpoint smoke.

Run the broad real local endpoint smoke directly with:

```sh
npm run smoke:local
```

It starts an in-process Fastify app, uses deterministic SDK `TestLLM`, hits the REST and WebSocket endpoints directly, verifies async user messages are preserved separately, and checks dummy `OH_SECRET` values are not persisted as plaintext metadata/events. It intentionally does not use `RemoteConversation` or `RemoteWorkspace`.

Generate this package's OpenAPI schema with:

```sh
npm run openapi
```

Generate all current SmolPaws OpenAPI artifacts from the repository root with:

```sh
scripts/generate-openapi.sh
```

Run the manual profile-driven workflow only when you intentionally want to spend real OpenAI model calls:

```sh
OPENAI_API_KEY=... npm run manual:llm
```

The workflow starts one local Fastify server and loads the `gpt-nano` and `gpt-mini` definitions from `examples/llm-profiles.json`. It creates both profiles through the REST API, deletes and re-adds one, activates `gpt-nano`, stores `OPENAI_API_KEY` through normal settings into an in-memory `SecretStore`, and starts a conversation without an injected `agentFactory` or serialized agent. That conversation reads and summarizes a README, then receives a follow-up that replaces the README with its summary. The workflow verifies events, final state, file download, git changes/diff, fork/delete, profile/settings snapshots, and that the agent did not commit.

It then activates `gpt-mini`, changes the conversation iteration setting, and starts a second independent conversation in a second git workspace. Both conversation IDs and persistence directories must differ, the second request must capture the new profile and settings, and the second README must remain unchanged. The final scan proves neither `OPENAI_API_KEY` nor the dummy `OH_SECRET` value appears in the temporary server tree. Direct `fetch` is intentional: this exercises the server contract rather than `RemoteConversation` or `RemoteWorkspace` convenience clients.

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
