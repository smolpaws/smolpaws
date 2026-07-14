# Slack App

Local Slack ingress app for SmolPaws using Socket Mode.

## Status

Phase 1 implementation: DMs (`message.im`) and channel mentions (`app_mention`) dispatched to the agent server via the shared turn API.

## How It Works

```text
Slack Socket Mode (WebSocket)
  → apps/slack (Bolt) — SlackAdapter (bridge)
  → src/shared/turnClient.ts
  → agent-server (127.0.0.1:8788)
  → outbound messages claimed by delivery owner
  → chat.postMessage with thread_ts
```

Same bridge pattern as `apps/discord`. The adapter self-registers with
`bridgeRegistry` and is discovered by the bridge loader via `plugin.json`.
When `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are present, the agent-server
starts it automatically at startup; `npm start` also runs it standalone.

## Files

| File | Purpose |
|------|---------|
| `plugin.json` | Bridge manifest — `kind: "bridge"`, requiredEnv, discovered by the loader |
| `src/adapter.ts` | `SlackAdapter extends BaseBridgeAdapter` — lifecycle, shared dispatch, delivery, registry registration |
| `src/index.ts` | Thin entry point — starts the adapter via `bridgeRegistry.startAdapter('slack', ...)` |
| `src/config.ts` | Env parsing and allowlists |
| `src/slackHandler.ts` | Ingress policy — access checks, dedup, thread context, normalization |
| `src/slackContext.ts` | Conversation ID generation, mention stripping, dedup |
| `src/__tests__/slackContext.test.ts` | Context helper tests |
| `src/__tests__/slackHandler.test.ts` | Ingress policy and normalization tests |
| `src/__tests__/slackAdapter.test.ts` | Shared dispatch and delivery integration tests |

## Local Dev

```bash
npm --prefix apps/slack install
npm --prefix apps/slack run dev    # watch mode
npm --prefix apps/slack run test   # unit tests
```

Requires `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `~/.smolpaws/.env`.

## Thread Follow-ups

Once the bot is @mentioned in a thread, it responds to all subsequent replies in that thread without requiring another @mention. Tracked in-memory (resets on restart). Requires `channels:history` scope and `message.channels` event subscription.

## Identity

The Slack app is named "paws" — it's smolpaws' Slack bot identity. Same cat, thinner surface: dispatches through the turn API without the full heartbeat/Chrome/memory stack. For the operational details (allowlist, known users, tokens), see `~/.smolpaws/slack/` and `~/.smolpaws/.env`.

## Access Control

- Allowlisted users (in `SLACK_ALLOWED_USER_IDS`): unlimited access
- Non-allowlisted users (when allowlist is active): 5 conversations max, tracked in `~/.smolpaws/slack/guest-usage.json`
- User ID → name mapping: `~/.smolpaws/slack/known-users.json`
- Note: Slack user IDs are per-workspace, not global. Same person has different IDs across workspaces.

## Documentation

- Architecture plan: [`../../docs/slack/README.md`](../../docs/slack/README.md)
- Setup notes: [`../../docs/slack/instructions.md`](../../docs/slack/instructions.md)
- Public arch page: [enyst.github.io/smolpaws-slack.html](https://enyst.github.io/smolpaws-slack.html)
