import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  ChannelType,
} from 'discord.js';
import pino from 'pino';
import { dispatchToAgentServer, type SmolpawsOutboundMessage } from './agentServerClient.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// --- Configuration ---

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
if (!DISCORD_BOT_TOKEN) {
  logger.fatal('DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

const RUNNER_URL = (
  process.env.SMOLPAWS_RUNNER_URL || 'http://127.0.0.1:8788'
).replace(/\/+$/, '');
const RUNNER_TOKEN = process.env.SMOLPAWS_RUNNER_TOKEN?.trim();

const TRIGGER = process.env.DISCORD_TRIGGER || '@smolpaws';
const TRIGGER_PATTERN = new RegExp(TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

// Optional: restrict to specific guild/channel IDs (comma-separated)
const ALLOWED_GUILDS = new Set(
  (process.env.DISCORD_ALLOWED_GUILDS || '').split(',').map((s) => s.trim()).filter(Boolean),
);
const ALLOWED_CHANNELS = new Set(
  (process.env.DISCORD_ALLOWED_CHANNELS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

// Discord message limit
const DISCORD_MAX_LENGTH = 2000;

// --- Helpers ---

function isAllowed(message: Message): boolean {
  if (ALLOWED_GUILDS.size > 0 && message.guildId && !ALLOWED_GUILDS.has(message.guildId)) {
    return false;
  }
  if (ALLOWED_CHANNELS.size > 0 && !ALLOWED_CHANNELS.has(message.channelId)) {
    return false;
  }
  return true;
}

function shouldRespond(message: Message, botUserId: string): boolean {
  if (message.author.bot) return false;

  // Respond if the bot is directly mentioned (@bot)
  if (message.mentions.has(botUserId)) return true;

  // Respond if the text trigger pattern matches
  if (TRIGGER_PATTERN.test(message.content)) return true;

  // Respond to DMs
  if (message.channel.type === ChannelType.DM) return true;

  return false;
}

function extractPrompt(content: string, botUserId: string): string {
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(TRIGGER_PATTERN, '')
    .trim();
}

function buildConversationId(message: Message): string {
  // In DMs, use the author's ID; in guilds, use channel ID for thread continuity
  if (message.channel.type === ChannelType.DM) {
    return `discord-dm-${message.author.id}`;
  }
  // Use thread ID if in a thread, otherwise channel ID
  const threadId = message.channel.isThread() ? message.channelId : null;
  if (threadId) {
    return `discord-thread-${threadId}`;
  }
  return `discord-channel-${message.channelId}`;
}

function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitAt < DISCORD_MAX_LENGTH * 0.5) {
      // No good newline break; split at space
      splitAt = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
    }
    if (splitAt < DISCORD_MAX_LENGTH * 0.3) {
      // Hard split
      splitAt = DISCORD_MAX_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function sendReply(message: Message, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await message.reply({
      content: chunk,
      allowedMentions: { parse: [] },
    });
  }
}

async function trySendTyping(message: Message): Promise<void> {
  const channel = message.channel;
  if (!('sendTyping' in channel)) {
    return;
  }
  try {
    await channel.sendTyping();
  } catch (error) {
    logger.warn({ error, channelId: message.channelId }, 'Discord typing indicator failed');
  }
}

async function deliverOutboundMessages(
  message: Message,
  outbound: SmolpawsOutboundMessage[],
): Promise<void> {
  for (const msg of outbound) {
    if (msg.kind === 'current_thread_message') {
      await sendReply(message, msg.text);
    }
  }
}

// --- Active conversations tracking (prevent duplicate processing) ---
const activeConversations = new Set<string>();

async function handleMessage(message: Message, botUserId: string): Promise<void> {
  const conversationId = buildConversationId(message);

  if (activeConversations.has(conversationId)) {
    logger.debug({ conversationId }, 'Conversation already active, skipping');
    return;
  }

  const prompt = extractPrompt(message.content, botUserId);
  if (!prompt) {
    await message.reply({
      content: '🐾 You called? Say something after the mention and I\'ll help.',
      allowedMentions: { parse: [] },
    });
    return;
  }

  activeConversations.add(conversationId);

  try {
    // Best-effort typing indicator only; missing permission should not block dispatch.
    const channel = message.channel;
    await trySendTyping(message);
    const typingInterval = setInterval(() => {
      void trySendTyping(message);
    }, 8000);

    logger.info(
      {
        author: message.author.tag,
        channel: message.channelId,
        guild: message.guildId,
        conversationId,
        promptLength: prompt.length,
      },
      'Processing Discord message',
    );

    const result = await dispatchToAgentServer({
      baseUrl: RUNNER_URL,
      token: RUNNER_TOKEN,
      conversationId,
      prompt,
      discord: {
        guild_id: message.guildId ?? undefined,
        channel_id: message.channelId,
        author_id: message.author.id,
        author_name: message.author.tag,
      },
      logger,
    });

    clearInterval(typingInterval);

    if (result.outboundMessages.length > 0) {
      await deliverOutboundMessages(message, result.outboundMessages);
    } else if (result.reply) {
      await sendReply(message, result.reply);
    } else {
      logger.warn({ conversationId }, 'No reply from agent');
    }
  } catch (error) {
    logger.error({ error, conversationId }, 'Error processing message');
    await message.reply({
      content: '🐾 Something went wrong on my end. Try again in a moment.',
      allowedMentions: { parse: [] },
    }).catch(() => {});
  } finally {
    activeConversations.delete(conversationId);
  }
}

// --- Bot setup ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // Needed for DMs
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info(
    {
      user: readyClient.user.tag,
      guilds: readyClient.guilds.cache.size,
      runnerUrl: RUNNER_URL,
    },
    'SmolPaws Discord bot is ready 🐾',
  );
});

client.on(Events.MessageCreate, async (message) => {
  if (!client.user) return;
  if (!shouldRespond(message, client.user.id)) return;
  if (!isAllowed(message)) return;

  await handleMessage(message, client.user.id);
});

client.on(Events.Error, (error) => {
  logger.error({ error }, 'Discord client error');
});

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down');
    client.destroy();
    process.exit(0);
  });
}

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  logger.fatal({ error }, 'Failed to login to Discord');
  process.exit(1);
});
