import type { Logger } from 'pino';
import type {
  IncomingMessage,
  ReplyContext,
} from '../../../src/shared/bridgeAdapter.js';
import type { SlackConfig } from './config.js';
import {
  buildConversationId,
  checkAccess,
  formatThreadContext,
  type GuestRateLimiter,
  type MentionedThreadTracker,
  type MessageDeduplicator,
  replyThreadTs,
  stripBotMention,
  type SlackEventContext,
  type ThreadMessage,
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
  fetchThreadMessages?: (channel: string, threadTs: string) => Promise<ThreadMessage[]>;
  dispatch: (message: IncomingMessage, replyContext: ReplyContext) => Promise<void>;
};

export async function handleSlackEvent(ctx: SlackEventContext, deps: SlackDeps): Promise<void> {
  const dedupKey = `${ctx.channelId}:${ctx.ts}`;
  if (!deps.dedup.tryBegin(dedupKey)) {
    deps.logger.debug({ dedupKey }, 'Duplicate Slack event, skipping');
    return;
  }

  let completed = false;
  let reservationHeld = true;
  const releaseReservation = (): void => {
    if (!reservationHeld) return;
    deps.dedup.release(dedupKey);
    reservationHeld = false;
  };

  try {
    const access = checkAccess(ctx, deps.config);
    if (access === 'denied') {
      deps.logger.info(
        { userId: ctx.userId, channelId: ctx.channelId },
        'Slack event denied by allowlist',
      );
      completed = true;
      return;
    }

    const isGuest = access === 'guest';
    if (isGuest && !deps.guestLimiter.isWithinLimit(ctx.userId)) {
      deps.logger.info({ userId: ctx.userId }, 'Guest user exceeded conversation limit');
      await deps.postMessage(
        ctx.channelId,
        '🐾 You\'ve used your guest conversations. Ask Engel to add you to the allowlist.',
        replyThreadTs(ctx),
      );
      completed = true;
      return;
    }

    deps.addReaction(ctx.channelId, ctx.ts, 'eyes').catch(() => {});

    const prompt = stripBotMention(ctx.text, ctx.botUserId);
    if (!prompt) {
      const hint = ctx.isDm
        ? '🐾 Send me a message and I\'ll help.'
        : '🐾 You called? Say something after the mention and I\'ll help.';
      await deps.postMessage(ctx.channelId, hint, replyThreadTs(ctx));
      completed = true;
      return;
    }

    const conversationId = buildConversationId(ctx);
    const threadTs = replyThreadTs(ctx);

    // Fetch thread context for threaded conversations.
    let fullPrompt = prompt;
    if (ctx.threadTs && ctx.threadTs !== ctx.ts && deps.fetchThreadMessages) {
      try {
        const threadMessages = await deps.fetchThreadMessages(ctx.channelId, ctx.threadTs);
        const contextPrefix = formatThreadContext(threadMessages, ctx.ts, ctx.botUserId);
        if (contextPrefix) {
          fullPrompt = contextPrefix + prompt;
        }
      } catch (error) {
        deps.logger.warn(
          { err: error, channelId: ctx.channelId, threadTs: ctx.threadTs },
          'Failed to fetch thread context',
        );
      }
    }

    deps.logger.info(
      {
        userId: ctx.userId,
        channelId: ctx.channelId,
        conversationId,
        isDm: ctx.isDm,
        promptLength: fullPrompt.length,
      },
      'Processing Slack message',
    );

    // For the coordinator path, this resolves only after the message has crossed the durable SQLite
    // acceptance boundary. That is the point at which process-local dedup and thread-follow-up state may
    // safely be committed.
    await deps.dispatch(
      {
        conversationId,
        messageId: dedupKey,
        prompt: fullPrompt,
        platformContext: {
          team_id: ctx.teamId,
          channel_id: ctx.channelId,
          user_id: ctx.userId,
          thread_ts: threadTs,
        },
      },
      { original: ctx, conversationId },
    );

    if (!ctx.isDm) {
      deps.mentionedThreads.track(ctx.threadTs ?? ctx.ts);
    }
    if (isGuest) deps.guestLimiter.record(ctx.userId);
    completed = true;
  } catch (error) {
    // A rejected dispatch means the durable intake boundary was not crossed. Release immediately,
    // before the best-effort Slack error reply, so a platform retry cannot be suppressed by slow or
    // failing chat.postMessage I/O.
    releaseReservation();
    deps.logger.error({ err: error }, 'Error processing Slack message');
    await deps
      .postMessage(
        ctx.channelId,
        '🐾 Something went wrong on my end. Try again in a moment.',
        replyThreadTs(ctx),
      )
      .catch(() => {});
  } finally {
    if (!reservationHeld) return;
    if (completed) deps.dedup.commit(dedupKey);
    else deps.dedup.release(dedupKey);
  }
}
