import type { Logger } from 'pino';
import type { SlackConfig } from './config.js';
import type { DispatchResult } from './agentServerClient.js';
import type { SmolpawsOutboundMessage } from '../../../src/shared/runner.js';
import {
  buildConversationId,
  checkAccess,
  type GuestRateLimiter,
  type MentionedThreadTracker,
  type MessageDeduplicator,
  replyThreadTs,
  stripBotMention,
  type SlackEventContext,
} from './slackContext.js';

const SLACK_MAX_LENGTH = 5900;

export function splitMessage(text: string): string[] {
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

export type SlackDeps = {
  config: SlackConfig;
  dedup: MessageDeduplicator;
  guestLimiter: GuestRateLimiter;
  mentionedThreads: MentionedThreadTracker;
  logger: Logger;
  postMessage: (channel: string, text: string, threadTs: string) => Promise<void>;
  addReaction: (channel: string, timestamp: string, name: string) => Promise<void>;
  dispatch: (options: {
    baseUrl: string;
    token?: string;
    conversationId: string;
    messageId: string;
    prompt: string;
    slack: { team_id: string; channel_id: string; user_id: string; thread_ts?: string };
    logger: Logger;
  }) => Promise<DispatchResult>;
};

export async function handleSlackEvent(ctx: SlackEventContext, deps: SlackDeps): Promise<void> {
  const dedupKey = `${ctx.channelId}:${ctx.ts}`;
  if (deps.dedup.isDuplicate(dedupKey)) {
    deps.logger.debug({ dedupKey }, 'Duplicate Slack event, skipping');
    return;
  }

  const access = checkAccess(ctx, deps.config);
  if (access === 'denied') {
    deps.logger.info({ userId: ctx.userId, channelId: ctx.channelId }, 'Slack event denied by allowlist');
    return;
  }
  const isGuest = access === 'guest';
  if (isGuest) {
    if (!deps.guestLimiter.isWithinLimit(ctx.userId)) {
      deps.logger.info({ userId: ctx.userId }, 'Guest user exceeded conversation limit');
      await deps.postMessage(ctx.channelId,
        '🐾 You\'ve used your guest conversations. Ask Engel to add you to the allowlist.',
        replyThreadTs(ctx));
      return;
    }
  }

  deps.addReaction(ctx.channelId, ctx.ts, 'eyes').catch(() => {});

  const prompt = stripBotMention(ctx.text, ctx.botUserId);
  if (!prompt) {
    const hint = ctx.isDm
      ? '🐾 Send me a message and I\'ll help.'
      : '🐾 You called? Say something after the mention and I\'ll help.';
    await deps.postMessage(ctx.channelId, hint, replyThreadTs(ctx));
    return;
  }

  if (!ctx.isDm) {
    const threadRoot = ctx.threadTs ?? ctx.ts;
    deps.mentionedThreads.track(threadRoot);
  }

  const conversationId = buildConversationId(ctx);
  const threadTs = replyThreadTs(ctx);

  deps.logger.info(
    { userId: ctx.userId, channelId: ctx.channelId, conversationId, isDm: ctx.isDm, promptLength: prompt.length },
    'Processing Slack message',
  );

  try {
    const result = await deps.dispatch({
      baseUrl: deps.config.runnerUrl,
      token: deps.config.runnerToken,
      conversationId,
      messageId: dedupKey,
      prompt,
      slack: {
        team_id: ctx.teamId,
        channel_id: ctx.channelId,
        user_id: ctx.userId,
        thread_ts: threadTs,
      },
      logger: deps.logger,
    });

    // Record guest usage only after successful dispatch — don't burn a
    // conversation slot on agent-server failures.
    if (isGuest) deps.guestLimiter.record(ctx.userId);

    for (const msg of result.outboundMessages) {
      if (msg.kind === 'current_thread_message') {
        await deps.postMessage(ctx.channelId, msg.text, threadTs);
      }
    }
    if (result.reply) {
      await deps.postMessage(ctx.channelId, result.reply, threadTs);
    }
    if (!result.reply && result.outboundMessages.length === 0) {
      deps.logger.warn({ conversationId }, 'No reply from agent');
    }
  } catch (error) {
    deps.logger.error({ err: error, conversationId }, 'Error processing Slack message');
    await deps.postMessage(ctx.channelId,
      '🐾 Something went wrong on my end. Try again in a moment.',
      threadTs).catch(() => {});
  }
}
