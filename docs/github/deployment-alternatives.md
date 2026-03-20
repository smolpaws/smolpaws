# Deployment alternatives

This repo has two viable deployment shapes depending on where you want the runner to live.

## Option A: Runner lives inside Daytona

**Summary**
- The Fastify runner itself runs inside the Daytona sandbox.
- `/api/conversations` and persistence are local to that sandbox.
- Cloudflare Worker queues events → Daytona runner endpoint directly.

**Implications**
- Persistence (`events.jsonl`, `state.json`) stays in the sandbox filesystem.
- Conversation listing and download endpoints read from the sandbox.
- Sandbox lifecycle controls uptime (auto-stop, per-PR vs per-job).

**Pros**
- Single place for execution + persistence.
- No need to sync files back to another host.

**Cons**
- Runner availability is tied to sandbox uptime.
- Requires a public Daytona preview URL for the Fastify port so Cloudflare can reach it.
  - Use the standard preview URL + `x-daytona-preview-token` header (skip signed URLs for now).

## Option B: Runner on a separate host, Daytona for execution only

**Summary**
- The Fastify runner runs on a stable host (Fly.io, Cloudflare Containers, etc.).
- Daytona is used only to execute agent runs.
- Runner persists conversations locally; sandboxes remain ephemeral.

**Implications**
- Runner persists `events.jsonl` on its own filesystem.
- Daytona runs return a reply; persistence stays outside Daytona.
- Optional: copy back files from Daytona if needed.

**Pros**
- Stable public API surface for `/api/*` endpoints.
- Easy to keep persistent state on the runner host.

**Cons**
- If you want sandbox artifacts, you must sync or fetch them.
- Requires extra host infra for the runner.
