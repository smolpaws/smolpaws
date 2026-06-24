/**
 * Slack channel adapter.
 *
 * Connects to Slack via @slack/bolt Socket Mode, listens for events, and
 * dispatches to the agent server. Unlike the Discord adapter, Slack has
 * richer ingress logic (thread context, dedup, guest rate limiting,
 * reactions) which lives in slackHandler.ts and is injected via SlackDeps.
 * This adapter owns the platform connection lifecycle and wires the handler.
 */

import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import {
  BaseBridgeAdapter,
  bridgeRegistry,
  type BridgeAdapterConfig,
  type ReplyContext,
} from '../../../src/shared/bridgeAdapter.js';
import { loadConfig, type SlackConfig } from './config.js';
import {
  GuestRateLimiter,
  MentionedThreadTracker,
  MessageDeduplicator,
  isThreadContextMessageSubtype,
  type SlackEventContext,
  type ThreadMessage,
} from './slackContext.js';
import { dispatchToAgentServer } from './agentServerClient.js';
import { handleSlackEvent, splitMessage, type SlackDeps } from './slackHandler.js';

export type SlackAdapterConfig = BridgeAdapterConfig & {
  slackConfig: SlackConfig;
};

export class SlackAdapter extends BaseBridgeAdapter {
  private app?: App;
  private botUserId = '';
  private readonly slackConfig: SlackConfig;
  private readonly dedup = new MessageDeduplicator();
  private readonly guestLimiter = new GuestRateLimiter();
  private readonly mentionedThreads = new MentionedThreadTracker();

  constructor(config: SlackAdapterConfig) {
    super(config);
    // The bridge loader is the source of truth for runner connection.
    this.slackConfig = {
      ...config.slackConfig,
      runnerUrl: this.runnerUrl,
      runnerToken: this.runnerToken,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  protected async connect(): Promise<void> {
    const app = new App({
      token: this.slackConfig.botToken,
      appToken: this.slackConfig.appToken,
      socketMode: true,
    });
    this.app = app;

    const deps = this.buildDeps();

    app.event('app_mention', async ({ event, context }) => {
      await this.processEvent(event, context.teamId, false, deps);
    });

    app.event('message', async ({ event, context }) => {
      const msg = event as GenericMessageEvent;

      // Skip edits and other message subtypes
      if (msg.subtype) return;

      const isDm = msg.channel_type === 'im';

      // For channel messages: only process thread replies in mentioned threads
      if (!isDm) {
        if (!msg.thread_ts || !this.mentionedThreads.isTracked(msg.thread_ts)) return;
      }

      await this.processEvent(msg, context.teamId, isDm, deps);
    });

    // Resolve bot identity before starting Socket Mode so event handlers
    // have botUserId available from the first event. Fail fast if it's
    // missing — otherwise every handler silently no-ops on the empty id.
    const auth = await app.client.auth.test();
    if (!auth.user_id) {
      throw new Error('Slack auth.test succeeded but returned no user_id');
    }
    this.botUserId = auth.user_id;

    await app.start();

    this.logger.info(
      { botUserId: this.botUserId, team: auth.team },
      'SmolPaws Slack bot is ready 🐾',
    );
  }

  protected async disconnect(): Promise<void> {
    try {
      await this.app?.stop();
    } catch (err) {
      this.logger.warn({ err }, 'Failed to stop Slack Socket Mode app cleanly');
    } finally {
      this.app = undefined;
    }
  }

  /**
   * Shared event pipeline for app_mention and message events: applies the
   * common bot-loop guards, builds the SlackEventContext, and dispatches
   * through handleSlackEvent with structured error logging. Each event
   * handler keeps its own type-specific pre-filters before calling this.
   */
  private async processEvent(
    event: SlackEventLike,
    teamId: string | undefined,
    isDm: boolean,
    deps: SlackDeps,
  ): Promise<void> {
    if (!this.botUserId) return;
    if (!event.user) return;
    // Prevent bot loops: ignore bot messages and self-mentions
    if (event.bot_id) return;
    if (event.user === this.botUserId) return;

    if (!teamId) {
      // Log only safe metadata — never the raw event (contains message text).
      this.logger.warn(
        { channel: event.channel, ts: event.ts, user: event.user },
        'Slack event missing team context',
      );
      return;
    }

    const ctx: SlackEventContext = {
      teamId,
      channelId: event.channel,
      userId: event.user,
      ts: event.ts,
      threadTs: event.thread_ts,
      text: event.text ?? '',
      isDm,
      botUserId: this.botUserId,
    };

    try {
      await handleSlackEvent(ctx, deps);
    } catch (err) {
      // Log only safe metadata — never the raw event (contains message text).
      this.logger.error(
        { err, channel: event.channel, ts: event.ts, user: event.user },
        'Failed to handle Slack event',
      );
    }
  }

  // ── Platform I/O ─────────────────────────────────────────────────

  /**
   * Satisfies the BaseBridgeAdapter contract. Slack ingress posts through
   * the injected handler (deps.postMessage), but this provides a direct
   * reply path keyed on the originating event. Slack/Bolt events use
   * snake_case; fall back to the message ts to start/reply in a thread.
   */
  protected async sendReply(ctx: ReplyContext, text: string): Promise<void> {
    const replyText = text.trim() || '🐾 Done — nothing to report back.';
    const event = ctx.original as { channel?: string; ts?: string; thread_ts?: string } | undefined;
    if (!event?.channel || !event?.ts) {
      this.logger.error({ original: ctx.original }, 'Cannot send reply: missing channel or ts in original event');
      return;
    }
    await this.postMessage(event.channel, replyText, event.thread_ts ?? event.ts);
  }

  // ── Handler wiring ───────────────────────────────────────────────

  private buildDeps(): SlackDeps {
    return {
      config: this.slackConfig,
      dedup: this.dedup,
      guestLimiter: this.guestLimiter,
      mentionedThreads: this.mentionedThreads,
      logger: this.logger,
      postMessage: (channel, text, threadTs) => this.postMessage(channel, text, threadTs),
      addReaction: (channel, timestamp, name) => this.addReaction(channel, timestamp, name),
      fetchThreadMessages: (channel, threadTs) => this.fetchThreadMessages(channel, threadTs),
      dispatch: dispatchToAgentServer,
    };
  }

  private async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    // Capture a local reference: disconnect() may null this.app mid-loop.
    const app = this.app;
    if (!app) return;
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

  private async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    const app = this.app;
    if (!app) return;
    await app.client.reactions.add({ channel, timestamp, name });
  }

  private async fetchThreadMessages(channel: string, threadTs: string): Promise<ThreadMessage[]> {
    const app = this.app;
    if (!app) return [];
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });
    if (!result.messages) return [];
    // Slack's MessageElement union doesn't surface username/subtype on the
    // top-level type; narrow to the fields we read. A for...of keeps the
    // value extraction type-safe without non-null assertions.
    const messages = result.messages as ReadonlyArray<SlackThreadReply>;
    const threadMessages: ThreadMessage[] = [];
    for (const m of messages) {
      const user = m.user ?? m.bot_id ?? m.username;
      if (user && m.text && m.ts && isThreadContextMessageSubtype(m.subtype)) {
        threadMessages.push({ user, text: m.text, ts: m.ts });
      }
    }
    return threadMessages;
  }
}

type SlackThreadReply = {
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  subtype?: string;
};

/**
 * Common shape across app_mention and message events for the fields the
 * shared pipeline reads. Both Bolt event types are structurally assignable.
 */
type SlackEventLike = {
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
};

// ── Register with the bridge registry ─────────────────────────────

bridgeRegistry.register('slack', (config) => {
  const slackConfig = loadConfig();
  return new SlackAdapter({ ...config, slackConfig });
});
