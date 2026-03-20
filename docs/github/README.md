# Smolpaws Ops Notes

## Planning / progress

- Historical convergence tracker: [../archive/compatibility-plan-progress.md](../archive/compatibility-plan-progress.md)

## Architecture (current)

1. **GitHub App** receives `issue_comment` + `pull_request_review_comment` webhooks.
2. **Cloudflare Worker** in `apps/github` validates signature + allowlists, then enqueues a job on **Cloudflare Queues**.
3. **Queue consumer** (same Worker) normalizes the GitHub event into a prompt-based `/run` request, while attaching optional GitHub context for Daytona.
4. **Fastify runner** in `apps/agent-server` uses `@smolpaws/agent-sdk` to run an agent and returns a reply.

```
GitHub → CF Worker (webhook/auth) → CF Queue → Fastify Runner → GitHub comment
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
- `ALLOWED_ACTORS` (ex: `enyst`)
- `ALLOWED_OWNERS` (ex: `enyst`)
- `ALLOWED_REPOS` (optional, ex: `enyst/smolpaws`)
- `ALLOWED_INSTALLATIONS` (optional)
- `SMOLPAWS_RUNNER_URL` (Fastify runner URL)
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

### Required env vars

- `LLM_MODEL` (required)
- `LLM_API_KEY` (required for hosted LLMs)
- `LLM_BASE_URL` (optional)
- `LLM_PROVIDER` (optional)
- `SMOLPAWS_RUNNER_TOKEN` (optional bearer auth)
- `SMOLPAWS_WORKSPACE_ROOT` (optional workspace path)
- `SMOLPAWS_PERSISTENCE_DIR` (optional persistence root; defaults to `~/.openhands/conversations`)
- `OPENHANDS_CONVERSATIONS_DIR` (optional alias for persistence root)
- `DAYTONA_API_KEY` (optional; enables Daytona runner)
- `DAYTONA_API_URL` (optional)
- `DAYTONA_TARGET` (optional)
- `SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES` (optional; defaults to 30)


## Deployment alternatives

See [deployment-alternatives.md](deployment-alternatives.md) for the two supported deployment shapes.

## Daytona integration

When `DAYTONA_API_KEY` is set, `apps/agent-server` can dispatch `/run` jobs into Daytona sandboxes.

**Behavior**
- PR events → per-PR sandbox keyed by `<head repo>#<pr number>` and reused.
- Non-PR events → per-job sandbox (created + deleted after run).

**Flow**
1. Runner receives `/run`.
2. Runner creates/reuses a sandbox via `@daytonaio/sdk`.
3. Sandbox bootstraps:
   - `git clone` target repo using the GitHub installation token
   - checkout PR head ref if available
   - install [`@smolpaws/agent-sdk`](https://www.npmjs.com/package/@smolpaws/agent-sdk) from npm
4. Execute the agent inside the sandbox; reply is returned to the runner.
5. Per-job sandboxes are deleted; per-PR sandboxes are left for Daytona auto-stop.

**Notes**
- Use `SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES` to control auto-stop. (default 30)
- The runner now exposes a websocket conversation stream at `/sockets/events/:conversationId`, including Python-compatible `session_api_key` query auth for browser-style clients and incoming user-message handling for the TypeScript `RemoteConversation` websocket path.
- Daytona process sessions may still be useful later if we want richer log streaming.
- Persistence lives on the runner host (`SMOLPAWS_PERSISTENCE_DIR`) while sandbox runs are ephemeral.

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

- Implement repo checkout for non-Daytona runs (clone + working dir setup) - can we in Workers?
- Decide whether any deeper persisted-conversation resume/rehydration behavior is worth supporting beyond the current explicit conflict responses for non-live control routes.
- Validate whether any remaining git parity beyond the query + legacy path-based `/api/git/*` forms is actually needed by the shared remote workspace surface.
