# Slack App

Local Slack ingress app for SmolPaws using Socket Mode.

## Status

Phase 1 implementation: DMs (`message.im`) and channel mentions (`app_mention`) dispatched to the agent server via the shared turn API.

## How It Works

```text
Slack Socket Mode (WebSocket)
  → apps/slack (Bolt)
  → src/shared/turnClient.ts
  → agent-server (127.0.0.1:8788)
  → outbound messages claimed by delivery owner
  → chat.postMessage with thread_ts
```

Same thin-ingress pattern as `apps/discord`.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Bolt app, event handlers, delivery loop |
| `src/config.ts` | Env parsing and allowlists |
| `src/slackContext.ts` | Conversation ID generation, mention stripping, dedup |
| `src/agentServerClient.ts` | Turn submission via shared `turnClient.ts` |
| `src/__tests__/slackContext.test.ts` | Context helper tests |
| `src/__tests__/agentServerClient.test.ts` | Dispatch tests |

## Local Dev

```bash
npm --prefix apps/slack install
npm --prefix apps/slack run dev    # watch mode
npm --prefix apps/slack run test   # unit tests
```

Requires `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `~/.smolpaws/.env`.

## Documentation

- Architecture plan: [`../../docs/slack/README.md`](../../docs/slack/README.md)
- Setup notes: [`../../docs/slack/instructions.md`](../../docs/slack/instructions.md)
- Public arch page: [enyst.github.io/smolpaws-slack.html](https://enyst.github.io/smolpaws-slack.html)
