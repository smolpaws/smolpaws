import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import pino from 'pino';
import { loadConfig } from './config.js';
import {
  GuestRateLimiter,
  MentionedThreadTracker,
  MessageDeduplicator,
  type SlackEventContext,
} from './slackContext.js';
import { dispatchToAgentServer } from './agentServerClient.js';
import { handleSlackEvent, splitMessage, type SlackDeps } from './slackHandler.js';

const config = loadConfig();

const logger = pino({
  level: config.logLevel,
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

const dedup = new MessageDeduplicator();
const guestLimiter = new GuestRateLimiter();
const mentionedThreads = new MentionedThreadTracker();

const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
});

let botUserId = '';

async function postMessage(channel: string, text: string, threadTs: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await app.client.chat.postMessage({
      channel,
      text: chunk,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

async function addReaction(channel: string, timestamp: string, name: string): Promise<void> {
  await app.client.reactions.add({ channel, timestamp, name });
}

const deps: SlackDeps = {
  config,
  dedup,
  guestLimiter,
  mentionedThreads,
  logger,
  postMessage,
  addReaction,
  dispatch: dispatchToAgentServer,
};

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

  await handleSlackEvent(ctx, deps);
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

  await handleSlackEvent(ctx, deps);
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
