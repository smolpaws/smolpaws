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
      if (!this.botUserId) return;
      if (!event.user) return;
      // Prevent bot loops: ignore bot messages and self-mentions
      if (event.bot_id) return;
      if (event.user === this.botUserId) return;

      const teamId = context.teamId;
      if (!teamId) {
        this.logger.warn('app_mention event missing team context');
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
        botUserId: this.botUserId,
      };

      try {
        await handleSlackEvent(ctx, deps);
      } catch (err) {
        this.logger.error({ err, event }, 'Failed to handle app_mention event');
      }
    });

    app.event('message', async ({ event, context }) => {
      if (!this.botUserId) return;
      const msg = event as GenericMessageEvent;

      // Skip bot messages, self-messages, edits, and subtypes
      if (msg.subtype) return;
      if (msg.bot_id) return;
      if (!msg.user) return;
      if (msg.user === this.botUserId) return;

      const isDm = msg.channel_type === 'im';

      // For channel messages: only process thread replies in mentioned threads
      if (!isDm) {
        if (!msg.thread_ts || !this.mentionedThreads.isTracked(msg.thread_ts)) return;
      }

      const teamId = context.teamId;
      if (!teamId) {
        this.logger.warn('message event missing team context');
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
        botUserId: this.botUserId,
      };

      try {
        await handleSlackEvent(ctx, deps);
      } catch (err) {
        this.logger.error({ err, event: msg }, 'Failed to handle message event');
      }
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
    if (!this.app) return;
    for (const chunk of splitMessage(text)) {
      await this.app.client.chat.postMessage({
        channel,
        text: chunk,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
    }
  }

  private async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    if (!this.app) return;
    await this.app.client.reactions.add({ channel, timestamp, name });
  }

  private async fetchThreadMessages(channel: string, threadTs: string): Promise<ThreadMessage[]> {
    if (!this.app) return [];
    const result = await this.app.client.conversations.replies({
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

// ── Register with the bridge registry ─────────────────────────────

bridgeRegistry.register('slack', (config) => {
  const slackConfig = loadConfig();
  return new SlackAdapter({ ...config, slackConfig });
});
