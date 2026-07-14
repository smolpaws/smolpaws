# Slack Ingress Plan

This document is the build plan for replacing SmolPaws' current Slack-via-Chrome setup with a real Slack app.

## Why

Today Slack access is a browser hack: SmolPaws reads and writes Slack by injecting JavaScript into a logged-in Chrome tab. That is fragile, visible, and hard to reason about.

The replacement should be a proper Slack app that:

- receives DMs and `@smolpaws` mentions directly from Slack
- submits work to the shared SmolPaws turn API
- posts replies back to the right DM, channel thread, or app thread
- can run locally without a public webhook URL

## Primary Decision

Start with **Socket Mode**, not HTTP webhooks.

Why:

- it avoids another public ingress surface
- it avoids a Cloudflare Worker or tunnel just for Slack
- it fits local development well
- it keeps the delivery model close to Discord and WhatsApp: one local long-running process

The first version should be a conventional Slack bot. Slack's richer AI-native surfaces can come later as a second phase.

## Target Architecture

```text
Slack DM or @mention
  -> apps/slack (Bolt + Socket Mode)
  -> shared turn client
  -> apps/agent-server
  -> turn result + claimed outbound messages
  -> Slack Web API reply
```

## MVP Scope

Phase 1 should support:

- DMs via `message.im`
- channel and thread mentions via `app_mention`
- replying in-thread with Slack `thread_ts`
- stable conversation ids derived from workspace/channel/thread
- optional allowlists for workspace, channel, and user
- additive outbound delivery using the existing turn API

Phase 1 should **not** try to solve everything:

- no Chrome dependency
- no Slack-specific scheduling UI
- no app-home polish requirement
- no full channel-history scraping by default

## Conversation Model

Use stable Slack-scoped conversation ids:

- DM: `slack-im-{team_id}-{channel_id}`
- channel root message: `slack-thread-{team_id}-{channel_id}-{ts}`
- threaded reply chain: `slack-thread-{team_id}-{channel_id}-{thread_ts}`

This keeps continuity aligned with Slack's own thread model.

## Delivery Model

The Slack app should use the existing turn API, not bespoke conversation plumbing.

Expected flow:

1. Slack policy code normalizes the event into the shared bridge message shape.
2. `BaseBridgeAdapter` builds a `create_conversation` payload with `ingress: "slack"` and Slack metadata.
3. Shared dispatch submits the user message through `POST /api/conversations/:id/turns` and monitors it.
4. If the app is the delivery owner, shared dispatch claims turn-scoped outbound messages.
5. `SlackAdapter` posts claimed outbound messages through `chat.postMessage`.
6. The final reply is the fallback when no outbound message was delivered.

This mirrors Discord's shared bridge dispatch path while leaving Slack policy and delivery in Slack.

## Slack Permissions Strategy

Keep the first version narrow.

Expected minimum bot scopes:

- `app_mentions:read`
- `chat:write`
- `im:history`

Possible follow-up scopes only if needed:

- `channels:history` for bounded public-thread context
- `groups:history` for bounded private-channel thread context
- `channels:read` or `groups:read` if channel metadata lookup becomes necessary

Do not request broad history scopes unless we actually implement and need them.

## Thread Context Strategy

Thread context should be permission-aware.

Rules:

- DMs: okay to fetch bounded prior context
- public/private channel threads: start with the current message and thread identifiers only
- later, if we add channel thread history, fetch only a bounded recent window
- never dump an entire long Slack thread into the prompt by default

This keeps the first version cheap, safer, and less likely to run into rate-limit or permission surprises.

## Slack-Native UX Later

After the basic bot works, a second phase can explore:

- App Home / Chat tab
- loading status for long-running turns
- streamed replies
- richer Slack blocks
- Slack-specific confirmation or task surfaces

Those should be optional polish layers over the same turn API, not a separate execution model.

## App Layout

- `apps/slack/src/index.ts` - thin standalone entrypoint
- `apps/slack/src/adapter.ts` - Socket Mode lifecycle, shared dispatch seam, and Slack delivery
- `apps/slack/src/config.ts` - env parsing and allowlist config
- `apps/slack/src/slackHandler.ts` - access, deduplication, thread context, and normalization
- `apps/slack/src/slackContext.ts` - conversation-id and metadata helpers
- `apps/slack/src/__tests__/...` - policy, normalization, and shared-dispatch regression tests
- `apps/slack/package.json` - isolated app scripts
- `apps/slack/AGENTS.md` - app-local guidance

## Local Runtime Shape

The Slack app should run as a local process, similar to Discord:

- loads `~/.smolpaws/.env`
- connects to Slack via Socket Mode
- talks to the local runner at `http://127.0.0.1:8788`
- does not require a public callback URL

Expected env vars:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SMOLPAWS_RUNNER_URL`
- `SMOLPAWS_RUNNER_TOKEN` if the runner requires auth
- optional allowlists such as `SLACK_ALLOWED_TEAM_IDS`, `SLACK_ALLOWED_CHANNEL_IDS`, `SLACK_ALLOWED_USER_IDS`

## Testing Plan

Implementation should come with:

- pure unit tests for Slack event parsing and conversation-id generation
- unit tests for delivery-owner behavior and duplicate suppression
- tests for DM and app-mention payload handling
- tests for bounded thread-context fetching rules
- a local smoke-test checklist for one DM and one channel-thread mention

## Rollout Plan

1. Build the scaffold and env/config shape.
2. Get DMs working end to end.
3. Add `app_mention` replies in channels and threads.
4. Add bounded thread context where permissions allow it.
5. Add service management and health checks.
6. Retire the Chrome Slack path once the app is stable.

## Open Questions

- Whether channel-thread history is worth the extra scopes in this workspace
- Whether to support the newer Slack AI app surfaces in phase 2 or keep the app as a classic bot
- Whether Slack should have its own LaunchAgent from day one or first ship as a manual dev process
