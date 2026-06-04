import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import pino from 'pino';
import { loadConfig } from './config.js';
import {
  buildConversationId,
  checkAccess,
  GuestRateLimiter,
  MentionedThreadTracker,
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
const guestLimiter = new GuestRateLimiter();
const mentionedThreads = new MentionedThreadTracker();

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
      const spaceSplit = remaining.lastIndexOf(' ', SLACK_MAX_LENGTH);
      if (spaceSplit > splitAt) splitAt = spaceSplit;
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

  const access = checkAccess(ctx, config);
  if (access === 'denied') {
    logger.info({ userId: ctx.userId, channelId: ctx.channelId }, 'Slack event denied by allowlist');
    return;
  }
  if (access === 'guest') {
    if (!guestLimiter.isWithinLimit(ctx.userId)) {
      logger.info({ userId: ctx.userId }, 'Guest user exceeded conversation limit');
      await postReply(ctx.channelId, replyThreadTs(ctx),
        '🐾 You\'ve used your guest conversations. Ask Engel to add you to the allowlist.');
      return;
    }
    guestLimiter.record(ctx.userId);
  }

  // React with eyes to acknowledge the message immediately
  app.client.reactions.add({
    channel: ctx.channelId,
    timestamp: ctx.ts,
    name: 'eyes',
  }).catch(() => {});

  const prompt = stripBotMention(ctx.text, ctx.botUserId);
  if (!prompt) {
    const hint = ctx.isDm
      ? '🐾 Send me a message and I\'ll help.'
      : '🐾 You called? Say something after the mention and I\'ll help.';
    await postReply(ctx.channelId, replyThreadTs(ctx), hint);
    return;
  }

  // Track channel threads after access check passes so denied mentions
  // don't open the thread for follow-ups.
  if (!ctx.isDm) {
    const threadRoot = ctx.threadTs ?? ctx.ts;
    mentionedThreads.track(threadRoot);
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
    logger.error({ err: error, conversationId }, 'Error processing Slack message');
    await postReply(ctx.channelId, threadTs,
      '🐾 Something went wrong on my end. Try again in a moment.').catch(() => {});
  }
}

// --- Event handlers ---

app.event('app_mention', async ({ event, context }) => {
  if (!botUserId) return;
  if (!event.user) return;
  // Prevent bot loops: ignore bot messages and self-mentions
  if (event.bot_id) return;
  if (event.user === botUserId) return;

  const teamId = context.teamId;
  if (!teamId) {
    logger.warn('app_mention event missing team context');
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

app.event('message', async ({ event, context }) => {
  if (!botUserId) return;
  const msg = event as GenericMessageEvent;

  // Skip bot messages, self-messages, edits, and subtypes
  if (msg.subtype) return;
  if (msg.bot_id) return;
  if (!msg.user) return;
  if (msg.user === botUserId) return;

  const isDm = msg.channel_type === 'im';

  // For channel messages: only process thread replies in mentioned threads
  if (!isDm) {
    if (!msg.thread_ts || !mentionedThreads.isTracked(msg.thread_ts)) return;
  }

  const teamId = context.teamId;
  if (!teamId) {
    logger.warn('message event missing team context');
    return;
  }

  const ctx: SlackEventContext = {
    teamId,
    channelId: msg.channel,
    userId: msg.user,
    ts: msg.ts,
    threadTs: msg.thread_ts,
    text: msg.text ?? '',
    isDm,
    botUserId,
  };

  await handleSlackEvent(ctx);
});

// --- Startup ---

async function start(): Promise<void> {
  // Resolve bot identity before starting Socket Mode so event handlers
  // have botUserId available from the first event.
  const auth = await app.client.auth.test();
  botUserId = (auth.user_id as string) ?? '';

  await app.start();

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
  logger.fatal({ err: error }, 'Failed to start Slack bot');
  process.exit(1);
});
