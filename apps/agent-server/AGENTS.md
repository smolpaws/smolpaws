# Agent Server

Shared Fastify agent-server app for SmolPaws ingress layers.

## Quick Context

This app exposes the local agent-server-compatible runtime surface used by both WhatsApp and GitHub ingress. It is intentionally separate from the host-specific ingress code.

## Key Files

| File | Purpose |
|------|---------|
| `src/runner.ts` | Thin entrypoint for local development |
| `src/agent-server/app.ts` | Fastify bootstrap |
| `src/agent-server/conversationRouter.ts` | `/run` and conversation routes |
| `src/agent-server/conversationRuntime.ts` | Local conversation lifecycle and persistence |
| `src/daytona.ts` | Current Daytona-specific execution helper; intended to become a workspace backend later |

## Development

```bash
npm run dev
npm run typecheck
container build -t smolpaws-runner:latest .
```
