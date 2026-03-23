# Smolpaws Ops Notes

## Planning / progress

- Historical convergence tracker: [../archive/compatibility-plan-progress.md](../archive/compatibility-plan-progress.md)

## Architecture (current)

1. **GitHub App** receives `issues` (opened), `issue_comment`, and `pull_request_review_comment` webhooks.
2. **Cloudflare Worker** in `apps/github` validates signature + allowlists, then enqueues a job on **Cloudflare Queues**.
3. **Queue consumer** (same Worker) creates or resumes a real conversation via `POST /api/conversations`, using a stable GitHub-thread-scoped `conversation_id`.
4. **Fastify agent-server** in `apps/agent-server` runs the conversation with the normal conversation lifecycle, then the Worker claims outbound messages and posts them back to GitHub.

```
GitHub issue or comment mention → CF Worker (webhook/auth) → CF Queue → Fastify Runner → GitHub comment
```

## Runtime ownership / distribution

- Canonical TypeScript runtime source: [`enyst/OpenHands-Tab/packages/agent-sdk`](https://github.com/enyst/OpenHands-Tab/tree/main/packages/agent-sdk)
- Python reference implementation: [`OpenHands/software-agent-sdk`](https://github.com/OpenHands/software-agent-sdk)
- Distribution path used by this repo: published npm package [`@smolpaws/agent-sdk`](https://www.npmjs.com/package/@smolpaws/agent-sdk)
- This repo now owns both the GitHub ingress app and the Fastify agent-server app, without carrying a repo-local fork of shared runtime logic.

## Cloudflare setup

### 1) Create the queue

```bash
npx wrangler queues create smolpaws-queue
```

### 2) Worker bindings

Already configured in `apps/github/wrangler.toml`:

```toml
[[queues.producers]]
queue = "smolpaws-queue"
binding = "SMOLPAWS_QUEUE"

[[queues.consumers]]
queue = "smolpaws-queue"
max_batch_size = 1
max_batch_timeout = 5
```

### 3) Worker secrets

Set in Cloudflare dashboard or via `wrangler secret put`:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `ALLOWED_ACTORS` (required, ex: `enyst`)
- `ALLOWED_OWNERS` (ex: `enyst`)
- `ALLOWED_REPOS` (optional, ex: `enyst/smolpaws`)
- `ALLOWED_INSTALLATIONS` (optional)
- `SMOLPAWS_RUNNER_URL` (Fastify agent-server base URL, e.g. `https://runner.example.com`)
- `SMOLPAWS_RUNNER_TOKEN` (Bearer token expected by runner)

### 4) Deploy Worker

From the repo root:

```bash
npm install
npm run github:deploy
```

## GitHub App setup

1. Create a GitHub App named `smolpaws`.
2. Permissions:
   - Issues: Read/Write
   - Pull Requests: Read/Write
   - Contents: Read
3. Events:
   - `issues`
   - `issue_comment`
   - `pull_request_review_comment`
4. Webhook URL: `https://<worker-host>/webhooks/github`
5. Add the webhook secret to `GITHUB_WEBHOOK_SECRET` in Cloudflare.
6. Install the app on the allowed repos.

## Fastify runner (agent-server)

### Run locally

```bash
npm install
LLM_MODEL=<model> LLM_API_KEY=<key> npm run runner:dev
```

Or use the checked-in launcher with env validation:

```bash
LLM_MODEL=<model> OPENAI_API_KEY=<key> npm run runner:local
```

The local launcher now binds to `127.0.0.1` by default. If you override `RUNNER_HOST` to a non-localhost address, you must also set `SMOLPAWS_RUNNER_TOKEN`.

### Agent-server runtime tests

```bash
# From the repository root
npm run agent-server:test
```

This runs the real Fastify app through `app.inject(...)` with a fake OpenAI-compatible stream and isolated temp repo/user-skill fixtures. See [../agent-server-testing.md](../agent-server-testing.md) for the harness shape and coverage boundaries.

### GitHub ingress tests

```bash
npm run github:test
```

This includes the Worker -> agent-server contract test and notifications-path coverage for issue-body mentions in repos where the GitHub App is not installed.

### Required env vars

- `LLM_MODEL` (required)
- `LLM_API_KEY` (required for hosted LLMs)
- `LLM_BASE_URL` (optional)
- `LLM_PROVIDER` (optional)
- `SMOLPAWS_RUNNER_TOKEN` (required for non-localhost binds; optional for localhost-only use)
- `RUNNER_HOST` (optional listen host; defaults to `127.0.0.1`)
- `SMOLPAWS_WORKSPACE_ROOT` (optional workspace path)
- `SMOLPAWS_PERSISTENCE_DIR` (optional persistence root; defaults to `~/.openhands/conversations`)
- `OPENHANDS_CONVERSATIONS_DIR` (optional alias for persistence root)

## Deployment alternatives

See [deployment-alternatives.md](deployment-alternatives.md) for the two supported deployment shapes.

## Daytona integration

Daytona is currently deferred as a workspace-level follow-up, not an active request path.

- The live GitHub ingress now targets the normal conversation API directly.
- The old `/run`-based Daytona shortcut has been removed.
- The intended future direction remains: Daytona should come back as a real workspace backend parallel to local execution, following the Python workspace model.

**Download events**
- `GET /api/conversations/:id/events/download`
- Requires `SMOLPAWS_RUNNER_TOKEN` if configured.
- Returns `application/x-ndjson` with the persisted `events.jsonl`.
- Available for persisted conversations as well as live in-memory runs.
- Use `?format=gz` or `Accept-Encoding: gzip` for a gzipped response.

**List conversations**
- `GET /api/conversations`
- Requires `SMOLPAWS_RUNNER_TOKEN` if configured.
- Returns `{ items: [{ id, created_at, updated_at, execution_status }] }`.
- Includes persisted conversations even when Daytona is not configured.


## Remaining work

- Implement repo checkout / workspace resolution for non-Daytona runs so GitHub mentions are not limited to one ambient runner root.
- Decide whether any deeper persisted-conversation resume/rehydration behavior is worth supporting beyond the current explicit conflict responses for non-live control routes.
- Reintroduce Daytona later as a real workspace backend instead of a request-path special case.
