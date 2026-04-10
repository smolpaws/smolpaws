# Smolpaws Ops Notes

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
- `SMOLPAWS_RUNNER_URL` (Fastify agent-server base URL, e.g. `https://runner.example.com`; do not append `/run`)
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
npm run runner:local
```

The checked-in launcher is the canonical local entrypoint:

```bash
npm run runner:local
```

The local launcher now binds to `127.0.0.1` by default. If `~/.smolpaws/.env` exists, it is loaded automatically before startup. The active LLM profile is resolved from `LLM_PROFILE_ID` first, then from the VS Code user setting `openhands.llm.profileId` in the configured user `settings.json`. Use `~/.smolpaws/.env` for local runtime secrets such as provider API keys and `GITHUB_TOKEN`. If you override `RUNNER_HOST` to a non-localhost address, you must also set `SMOLPAWS_RUNNER_TOKEN`.

For GitHub-triggered runs, the agent-server now resolves the local repo workspace automatically:

- first, for mismatched local clone names, by `~/.smolpaws/repo-map.json`
- then by a local clone under `SMOLPAWS_WORKSPACE_ROOT` whose directory name matches the GitHub repo name
- otherwise by the configured default working dir

Example `~/.smolpaws/repo-map.json`:

```json
{
  "OpenHands/OpenHands-Tab": "oh-tab",
  "OpenHands/software-agent-sdk": "agent-sdk"
}
```

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

This includes the Worker -> agent-server contract test and notifications-path coverage for issue-body mentions, inline PR review comments, and PR review bodies in repos where the GitHub App is not installed.

## Recommended local test flow

The real end-to-end GitHub test path we have actually used on this machine is:

1. Keep the GitHub App webhook pointed at the deployed Worker domain.
2. Start the local runner:

```bash
npm run runner:local
```

3. Expose the local runner:

```bash
cloudflared tunnel --url http://127.0.0.1:8788
```

4. Update the deployed Worker secret `SMOLPAWS_RUNNER_URL` to the public tunnel URL.

### Starting or restarting `cloudflared`

If GitHub ingress suddenly stops reaching the local runner, restart the tunnel and then update the Worker secret to the new tunnel URL.

Start a fresh tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8788
```

If an old tunnel process is still around and you want a clean restart first:

```bash
pkill -f 'cloudflared tunnel --url http://127.0.0.1:8788' || true
cloudflared tunnel --url http://127.0.0.1:8788
```

After it prints a `https://...trycloudflare.com` URL:

1. Set the deployed Worker secret `SMOLPAWS_RUNNER_URL` to that URL.
2. Confirm the tunnel can reach the local runner:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/ready
curl https://<new-trycloudflare-url>/health
curl https://<new-trycloudflare-url>/ready
```

In this mode:

- GitHub still talks to Cloudflare
- Cloudflare then talks back to your laptop through the tunnel
- the tunnel only works while the `cloudflared` process stays running
- Cloudflare continues using the secrets already configured on the deployed Worker

Quick checks:

```bash
curl http://127.0.0.1:8788/health
curl https://<your-worker-domain>/health
```

This mode is preferred when Cloudflare already has the GitHub App secrets and you do not want to duplicate them into a local Worker dev setup.

### Debugging the deployed Worker

When a GitHub notification flips from unread to read but nothing shows up under `~/.openhands/conversations`, inspect the deployed Worker logs first:

```bash
cd apps/github
wrangler tail
```

The Worker emits stable log markers for the notifications path:

- `github.notifications.poll.fetched`
- `github.notifications.read.already_enqueued_notification`
- `github.notifications.read.no_valid_mention`
- `github.notifications.read.blocked_by_allowlist`
- `github.notifications.read.duplicate_mention_identity`
- `github.notifications.queue.enqueued`
- `github.queue.process.start`
- `github.queue.process.completed`

Useful fields in those logs:

- `thread_id`: GitHub notification thread id
- `repo`
- `issue_number`
- `actor`
- `dedupe_identity`
- `mention_identity`
- `notification_thread_id`

The useful split is:

- `github.notifications.*` explains why the notifications poller marked a thread read
- `github.queue.*` shows whether the queued message actually made it through runner delivery

When GitHub omits `subject.latest_comment_url` for a `reason: "mention"` notification, the Worker now reconstructs the mention by scanning the thread body plus recent issue comments, PR review comments, and PR reviews, then chooses the best candidate near the notification timestamp.

### Required env vars

- `LLM_PROFILE_ID` (optional if VS Code user settings already define `openhands.llm.profileId`)
- provider API key(s) for the selected profile, usually one of:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GEMINI_API_KEY`
  - `OPENROUTER_API_KEY`
  - `LITELLM_API_KEY`
- `GITHUB_TOKEN` (optional local runtime GitHub token for the agent)
- `SMOLPAWS_RUNNER_TOKEN` (required for non-localhost binds; optional for localhost-only use)
- `RUNNER_HOST` (optional listen host; defaults to `127.0.0.1`)
- `SMOLPAWS_WORKSPACE_ROOT` (optional workspace path)
- `SMOLPAWS_REPO_MAP_PATH` (optional override for `~/.smolpaws/repo-map.json`)
- `SMOLPAWS_PERSISTENCE_DIR` (optional persistence root; defaults to `~/.openhands/conversations`)
- `SMOLPAWS_VSCODE_SETTINGS_PATH` (optional override for the VS Code user settings file used to resolve `openhands.llm.profileId`)
- `OPENHANDS_CONVERSATIONS_DIR` (optional alias for persistence root)

## Deployment alternatives

See [deployment-alternatives.md](deployment-alternatives.md) for the two supported deployment shapes.

## Daytona integration

Daytona is currently deferred as a workspace-level follow-up, not an active request path.

- The live GitHub ingress now targets the normal conversation API directly.
- The old top-level runner shortcut path has been removed.
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

- Decide whether any deeper persisted-conversation resume/rehydration behavior is worth supporting beyond the current explicit conflict responses for non-live control routes.
- Reintroduce Daytona later as a real workspace backend instead of a request-path special case.
