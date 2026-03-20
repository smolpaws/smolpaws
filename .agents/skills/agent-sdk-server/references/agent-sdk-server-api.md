# Smolpaws Agent SDK server API

Source: `src/runner.ts`.

## Health & info

- `GET /health` → `{ ok: true }`
- `GET /alive` → `{ status: "ok" }`
- `GET /ready` → `{ status: "ready" }`
- `GET /server_info` → `{ uptime, idle_time, title, version, docs, redoc }`

## Runner endpoint

- `POST /run` (Cloudflare worker/queue target)
  - Body: `{ event: "issue_comment" | "pull_request_review_comment", payload: <GitHub event>, delivery_id? }`
  - Response: `{ reply: string }`
  - Uses `SMOLPAWS_RUNNER_TOKEN` bearer auth if configured.

## Conversation API

- `POST /api/conversations`
  - Body: `{ agent, workspace?, secrets?, confirmation_policy?, max_iterations?, stuck_detection?, stuck_detection_thresholds?, initial_message?, conversation_id? }`
  - Response: `{ id, created_at, updated_at, execution_status }`
- `GET /api/conversations/:conversationId`
- `POST /api/conversations/:conversationId/pause`
- `POST /api/conversations/:conversationId/run`

### Conversation settings

- `POST /api/conversations/:conversationId/confirmation_policy`
- `POST /api/conversations/:conversationId/security_analyzer`
- `POST /api/conversations/:conversationId/secrets`

### Conversation actions

- `POST /api/conversations/:conversationId/ask_agent`
- `POST /api/conversations/:conversationId/generate_title`
- `POST /api/conversations/:conversationId/condense`

### Events

- `POST /api/conversations/:conversationId/events` (user messages only)
- `POST /api/conversations/:conversationId/events/respond_to_confirmation`
- `GET /api/conversations/:conversationId/events/search?page_id=&limit=`
- `GET /api/conversations/:conversationId/events/download` (requires auth + Daytona)

## Auth

If `SMOLPAWS_RUNNER_TOKEN` is set, include `Authorization: Bearer <token>` for protected endpoints (run + download).
