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

      await handleSlackEvent(ctx, deps);
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

      await handleSlackEvent(ctx, deps);
    });

    // Resolve bot identity before starting Socket Mode so event handlers
    // have botUserId available from the first event.
    const auth = await app.client.auth.test();
    this.botUserId = (auth.user_id as string) ?? '';

    await app.start();

    this.logger.info(
      { botUserId: this.botUserId, team: auth.team },
      'SmolPaws Slack bot is ready 🐾',
    );
  }

  protected async disconnect(): Promise<void> {
    await this.app?.stop().catch(() => {});
    this.app = undefined;
  }

  // ── Platform I/O ─────────────────────────────────────────────────

  /**
   * Satisfies the BaseBridgeAdapter contract. Slack ingress posts through
   * the injected handler (deps.postMessage), but this provides a direct
   * reply path keyed on the originating event.
   */
  protected async sendReply(ctx: ReplyContext, text: string): Promise<void> {
    if (!text.trim()) return;
    const event = ctx.original as { channel: string; threadTs: string };
    await this.postMessage(event.channel, text, event.threadTs);
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

  private async postMessage(channel: string, text: string, threadTs: string): Promise<void> {
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
    // top-level type; narrow to the fields we read.
    const messages = result.messages as ReadonlyArray<SlackThreadReply>;
    return messages
      .filter((m) =>
        (m.user || m.bot_id || m.username) &&
        m.text &&
        m.ts &&
        isThreadContextMessageSubtype(m.subtype))
      .map((m) => ({ user: m.user ?? m.bot_id ?? m.username!, text: m.text!, ts: m.ts! }));
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
