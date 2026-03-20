# GitHub Ingress

Cloudflare Worker app for GitHub webhook and notification ingress.

## Quick Context

This app validates GitHub events, queues work, forwards prompts to the shared SmolPaws runner surface, and posts replies back to the active issue or pull request thread.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entrypoint, queue consumer, GitHub API helpers |
| `wrangler.toml` | Cloudflare Worker/Queues configuration |
| `../../apps/agent-server/src/shared/runner.ts` | Shared runner protocol types |

## Development

```bash
npm run dev
npm run typecheck
```
