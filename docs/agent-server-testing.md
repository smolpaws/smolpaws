# Agent-Server Runtime Tests

The canonical agent-server test entrypoint, run from the repository root, is:

```bash
npm run agent-server:test
```

That command runs `apps/agent-server/src/agent-server/*.test.ts` through `tsx --test`.

## Current test style

These tests intentionally follow the same habits we use in `OpenHands-Tab` for the TypeScript SDK:

- exercise real runtime paths instead of helper-only mocks
- capture the first LLM request directly when prompt shape matters
- assert the exposed tool set explicitly
- keep the harness small and local to the behavior under test

## Current harness

`apps/agent-server/src/agent-server/conversationRuntime.test.ts` uses:

- the real Fastify app from `createAgentServerApp(...)`
- `app.inject(...)` against the canonical `POST /api/conversations` and `POST /api/conversations/:id/run` routes
- a tiny fake OpenAI-compatible SSE server instead of a hosted LLM
- isolated temporary repo fixtures under a temporary `HOME`
- temporary user skills under `~/.openhands/skills`

That means the tests exercise the same local conversation path that the live agent-server uses, including:

- `createConversationRecord(...)`
- `AgentContext`
- project skill loading
- user skill loading
- default tool exposure
- SmolPaws-added tools like `send_message`

## Covered scenarios

Current runtime coverage focuses on the first turn and the canonical queued-run path:

1. First request prompt shape
   - verifies `<REPO_CONTEXT>`, `<SKILLS>`, and `<environment information>`
   - checks GitHub repo/thread metadata
   - checks the current default workspace facts:
     - workspace root convention: `~/repos`
     - default `working_dir`: `smolpaws`
     - resolved startup dir: `~/repos/smolpaws`

2. Tool exposure
   - verifies the default remote GitHub tool set plus `send_message`
   - verifies requested remote tools can narrow the exposed set cleanly

3. Queued idle runs
   - verifies `initial_message.run = false` does not hit the LLM immediately
   - verifies `POST /api/conversations/:id/run` triggers the queued canonical path

## Complementary tests

The runtime tests do not replace the GitHub Worker contract test:

```bash
npm run github:test:agent-server-contract
```

That test covers the Worker-side request shape sent into the agent-server. The runtime tests cover what the agent-server does after it receives that request.

CI runs both.

## Deliberate boundaries

These tests do not currently cover:

- real Cloudflare Worker webhook delivery
- GitHub posting against the live API
- WhatsApp ingress
- Daytona-backed execution
- multi-repo local checkout resolution beyond the current ambient-root/default-working-dir model

Those need separate higher-level tests or future end-to-end coverage.
