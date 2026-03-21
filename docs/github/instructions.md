# Hybrid GitHub mention intake (webhooks + notifications)

This repo supports two independent ways to trigger the agent when someone mentions `@smolpaws ...`.

- Webhook path (GitHub App): near-real-time for repos where the GitHub App is installed.
- Notifications path (GitHub user token): works across any repo where the `smolpaws` user receives a GitHub notification for the mention.

Both paths converge into the same pipeline:

GitHub -> `apps/github` Worker -> Queue -> `apps/agent-server` Runner -> GitHub comment reply

## Cloudflare free plan notes

This implementation is intended to run on Cloudflare using only features that are available on the Workers Free plan:

- Workers (HTTP handler)
- Cron Triggers (scheduled polling)
- Queues (buffering + retries)
- Cache API (best-effort dedupe for notification thread IDs)

We intentionally avoid requiring Durable Objects, D1, or KV for correctness. If you need stronger dedupe guarantees than the Cache API can provide (for example across cache eviction), the next step would be KV/D1, but this PR keeps the core path free-plan-friendly.


## 1) Webhook path (GitHub App)

### What you get
- Fast, event-driven triggers
- Installation-scoped permissions
- Only works for repos where the GitHub App is installed

### Required Worker secrets
Set these as Cloudflare Worker secrets (e.g. via `wrangler secret put ...`):

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`

### GitHub App configuration
- Subscribe to webhook events:
  - `issues` (opened)
  - `issue_comment` (created)
  - `pull_request_review_comment` (created)
- Webhook URL:
  - `https://<your-worker-domain>/webhooks/github`

## 2) Notifications path (GitHub user token)

### What you get
- Works for mentions in any repo where the `smolpaws` GitHub user can see the thread
- Does not require the GitHub App to be installed
- Polling-based (cron), not instant

### Required Worker secret
- `GITHUB_USER_TOKEN`

This should be a token for the `smolpaws` GitHub user.

Minimum permissions depend on where you want it to operate:
- To read mentions: needs access to Notifications.
- To reply back: needs permission to create issue comments in the target repos.

Token guidance:
- If you truly want "any repo" (across all of GitHub where the `smolpaws` user has visibility), a classic PAT is usually the simplest option.
  - Public-only replying: `public_repo` + `notifications`
  - Public + private replying: `repo` + `notifications`
- A fine-grained PAT is typically limited to a single owner (user/org) and selected repositories, so it usually cannot cover "any repo" unless you intentionally restrict the scope.

### Cron trigger
The Worker is configured with an hourly cron schedule in `apps/github/wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]
```

On each tick the Worker:
1. Calls `GET https://api.github.com/notifications?per_page=50`
2. Filters notifications where `reason == "mention"`
3. Fetches the latest comment (`subject.latest_comment_url`) and checks for `@smolpaws`
4. Enqueues a queue message for processing
5. Marks the notification thread as read

## 3) Allowlisting / spam control

The Worker can restrict which mentions are accepted via environment variables:

- `ALLOWED_ACTORS`: comma-separated GitHub usernames
- `ALLOWED_OWNERS`: comma-separated repo owners/orgs
- `ALLOWED_REPOS`: comma-separated full repo names (`owner/repo`)
- `ALLOWED_INSTALLATIONS`: comma-separated GitHub App installation IDs (only applies when an installation id is present)

Recommended configuration for this deployment (respond only to specific GitHub users):

```toml
ALLOWED_ACTORS = "amanape,neubig,enyst,mamoodi,malhotra5,rbren,xingyaoww"
```

Where to set it:
- Production: set `ALLOWED_ACTORS` as a Worker variable in the Cloudflare dashboard (or via `wrangler deploy --var ...`).
- Local/dev: you can also commit it in `wrangler.toml` under `[vars]`.

Notes:
- For the notifications path there is no `installation.id`, so `ALLOWED_INSTALLATIONS` is ignored.
- If you enable notifications without allowlists, anyone can mention `@smolpaws` in public repos and trigger replies.

## 4) Runner integration

### Worker -> Runner
If configured, the Worker will call the Runner URL:

- `SMOLPAWS_RUNNER_URL` (agent-server base URL, e.g. `https://runner.example.com`)
- Optional: `SMOLPAWS_RUNNER_TOKEN` (Bearer token)

The Worker creates or resumes a real conversation on the agent-server:

```json
{
  "agent": {
    "llm": {},
    "tools": [
      { "name": "terminal" },
      { "name": "file_editor" },
      { "name": "task_tracker" }
    ]
  },
  "conversation_id": "github-owner-repo-123",
  "initial_message": {
    "role": "user",
    "content": [{ "type": "text", "text": "..." }],
    "run": true
  },
  "smolpaws": {
    "ingress": "github_webhook",
    "enable_send_message": true
  }
}
```

### Runner required env
At minimum:

- `LLM_MODEL`
- `LLM_API_KEY`

## 5) Operational notes

- The notifications path marks threads as read after enqueueing. If a queue job fails and retries, it will not be re-enqueued by polling (but the queued message will still retry).
- For private repos, the `smolpaws` user must have repo access or notifications will not be delivered.
