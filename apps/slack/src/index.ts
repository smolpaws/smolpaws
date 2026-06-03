import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import pino from 'pino';
import { loadConfig } from './config.js';
import {
  buildConversationId,
  isAllowed,
  MessageDeduplicator,
  replyThreadTs,
  stripBotMention,
  type SlackEventContext,
} from './slackContext.js';
import { dispatchToAgentServer, type SmolpawsOutboundMessage } from './agentServerClient.js';

const config = loadConfig();

const logger = pino({
  level: config.logLevel,
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const SLACK_MAX_LENGTH = 3900;
const dedup = new MessageDeduplicator();

const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
});

let botUserId = '';

function splitMessage(text: string): string[] {
  if (text.length <= SLACK_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', SLACK_MAX_LENGTH);
    if (splitAt < SLACK_MAX_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', SLACK_MAX_LENGTH);
    }
    if (splitAt < SLACK_MAX_LENGTH * 0.3) {
      splitAt = SLACK_MAX_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function postReply(
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await app.client.chat.postMessage({
      channel: channelId,
      text: chunk,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

async function deliverOutbound(
  channelId: string,
  threadTs: string,
  messages: SmolpawsOutboundMessage[],
): Promise<void> {
  for (const msg of messages) {
    if (msg.kind === 'current_thread_message') {
      await postReply(channelId, threadTs, msg.text);
    }
  }
}

async function handleSlackEvent(ctx: SlackEventContext): Promise<void> {
  const dedupKey = `${ctx.channelId}:${ctx.ts}`;
  if (dedup.isDuplicate(dedupKey)) {
    logger.debug({ dedupKey }, 'Duplicate Slack event, skipping');
    return;
  }

  if (!isAllowed(ctx, config)) {
    logger.info({ userId: ctx.userId, channelId: ctx.channelId }, 'Slack event rejected by allowlist');
    return;
  }

  const prompt = stripBotMention(ctx.text, ctx.botUserId);
  if (!prompt) {
    await postReply(ctx.channelId, replyThreadTs(ctx),
      '🐾 You called? Say something after the mention and I\'ll help.');
    return;
  }

  const conversationId = buildConversationId(ctx);
  const threadTs = replyThreadTs(ctx);

  logger.info(
    {
      userId: ctx.userId,
      channelId: ctx.channelId,
      conversationId,
      isDm: ctx.isDm,
      promptLength: prompt.length,
    },
    'Processing Slack message',
  );

  try {
    const result = await dispatchToAgentServer({
      baseUrl: config.runnerUrl,
      token: config.runnerToken,
      conversationId,
      messageId: dedupKey,
      prompt,
      slack: {
        team_id: ctx.teamId,
        channel_id: ctx.channelId,
        user_id: ctx.userId,
        thread_ts: threadTs,
      },
      logger,
    });

    if (result.outboundMessages.length > 0) {
      await deliverOutbound(ctx.channelId, threadTs, result.outboundMessages);
    }
    if (result.reply) {
      await postReply(ctx.channelId, threadTs, result.reply);
    }
    if (!result.reply && result.outboundMessages.length === 0) {
      logger.warn({ conversationId }, 'No reply from agent');
    }
  } catch (error) {
    logger.error({ error, conversationId }, 'Error processing Slack message');
    await postReply(ctx.channelId, threadTs,
      '🐾 Something went wrong on my end. Try again in a moment.').catch(() => {});
  }
}

// --- Event handlers ---

app.event('app_mention', async ({ event }) => {
  if (!botUserId) return;
  if (!event.user) return;
  // team is present on app_mention events but not in the base type
  const teamId = (event as unknown as Record<string, unknown>).team as string | undefined;
  if (!teamId) {
    logger.warn('app_mention event missing team field');
    return;
  }

  const ctx: SlackEventContext = {
    teamId,
    channelId: event.channel,
    userId: event.user,
    ts: event.ts,
    threadTs: event.thread_ts,
    text: event.text ?? '',
    isDm: false,
    botUserId,
  };

  await handleSlackEvent(ctx);
});

app.event('message', async ({ event }) => {
  if (!botUserId) return;
  const msg = event as GenericMessageEvent;

  // Only handle DMs — channel messages use app_mention
  if (msg.channel_type !== 'im') return;
  // Skip bot messages, edits, and subtypes
  if (msg.subtype) return;
  if (msg.bot_id) return;
  if (!msg.user) return;

  // team is present on message events but not always in the base type
  const teamId = (msg as unknown as Record<string, unknown>).team as string | undefined;
  if (!teamId) {
    logger.warn('DM message event missing team field');
    return;
  }

  const ctx: SlackEventContext = {
    teamId,
    channelId: msg.channel,
    userId: msg.user,
    ts: msg.ts,
    threadTs: msg.thread_ts,
    text: msg.text ?? '',
    isDm: true,
    botUserId,
  };

  await handleSlackEvent(ctx);
});

// --- Startup ---

async function start(): Promise<void> {
  await app.start();

  const auth = await app.client.auth.test();
  botUserId = (auth.user_id as string) ?? '';

  logger.info(
    {
      botUserId,
      team: auth.team,
      runnerUrl: config.runnerUrl,
    },
    'SmolPaws Slack bot is ready 🐾',
  );
}

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down');
    await app.stop().catch(() => {});
    process.exit(0);
  });
}

start().catch((error) => {
  logger.fatal({ error }, 'Failed to start Slack bot');
  process.exit(1);
});
