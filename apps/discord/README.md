# SmolPaws Discord Ingress

Discord bot that connects SmolPaws to Discord servers and DMs.

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** → name it `smolpaws`
3. Go to **Bot** → click **Reset Token** → copy the token
4. Under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required to read message text)
5. Go to **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `View Channels`
6. Copy the generated URL and open it to invite the bot to your server

### 2. Configure Environment

Add to `~/.smolpaws/.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token-here

# Optional: restrict to specific servers/channels (comma-separated IDs)
# DISCORD_ALLOWED_GUILDS=123456789012345678
# DISCORD_ALLOWED_CHANNELS=123456789012345678

# Agent server (defaults to local)
# SMOLPAWS_RUNNER_URL=http://127.0.0.1:8788
# SMOLPAWS_RUNNER_TOKEN=your-token
```

### 3. Install Dependencies

```bash
cd apps/discord
npm install
```

### 4. Run

```bash
# From the repo root
npm run discord:dev    # Development (auto-reload)
npm run discord:start  # Production
```

## How It Works

- The bot connects to Discord via the Gateway (WebSocket)
- Responds to:
  - Direct `@smolpaws` mentions in server channels
  - Text trigger `@smolpaws` in messages
  - All DMs
- Routes messages to the local agent-server (`/api/conversations`)
- Sends the agent's response back to the Discord channel
- Shows typing indicator while the agent is working
- Splits long responses (>2000 chars) across multiple messages

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ | — | Bot token from Discord Developer Portal |
| `DISCORD_TRIGGER` | — | `@smolpaws` | Text trigger pattern |
| `DISCORD_ALLOWED_GUILDS` | — | (all) | Comma-separated guild IDs to respond in |
| `DISCORD_ALLOWED_CHANNELS` | — | (all) | Comma-separated channel IDs to respond in |
| `SMOLPAWS_RUNNER_URL` | — | `http://127.0.0.1:8788` | Agent server URL |
| `SMOLPAWS_RUNNER_TOKEN` | — | — | Agent server auth token |
| `LOG_LEVEL` | — | `info` | Log level (debug, info, warn, error) |

## Conversation Threading

- **DMs**: One conversation per user (`discord-dm-{user_id}`)
- **Threads**: One conversation per thread (`discord-thread-{thread_id}`)
- **Channels**: One conversation per channel (`discord-channel-{channel_id}`)
