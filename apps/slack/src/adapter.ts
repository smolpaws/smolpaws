/**
 * Standalone Slack Socket Mode bridge for the durable Message Relay architecture.
 *
 * Slack is intentionally greenfield. It owns its Bolt connection and relay runtime directly; it does
 * not inherit the legacy BaseBridgeAdapter and cannot fall back to `/turns` accidentally.
 */
import { App } from '@slack/bolt';
import type { GenericMessageEvent } from '@slack/types';
import type { Logger } from 'pino';

import type {
  IncomingMessage,
  ReplyContext,
} from '../../../src/shared/bridgeAdapter.js';
import { loadConfig, type SlackConfig } from './config.js';
import { SlackRelayRuntime } from './relayRuntime.js';
import {
  GuestRateLimiter,
  MentionedThreadTracker,
  MessageDeduplicator,
  isThreadContextMessageSubtype,
  type SlackEventContext,
  type ThreadMessage,
} from './slackContext.js';
import { handleSlackEvent, splitMessage, type SlackDeps } from './slackHandler.js';

export interface SlackBridgeOptions {
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  slackConfig?: SlackConfig;
  /** Override the durable Message Relay DB, mainly for isolated live canaries. */
  dbPath?: string;
  /** Override the relay polling interval. */
  tickMs?: number;
  /** Additional upstream-shaped conversation defaults for this bridge instance. */
  createConversationDefaults?: Record<string, unknown>;
}

export class SlackBridge {
  private app?: App;
  private runtime?: SlackRelayRuntime;
  private botUserId = '';
  private readonly logger: Logger;
  private readonly serverUrl: string;
  private readonly sessionApiKey?: string;
  private readonly slackConfig: SlackConfig;
  private readonly dbPath?: string;
  private readonly tickMs?: number;
  private readonly createConversationDefaults?: Record<string, unknown>;
  private readonly dedup = new MessageDeduplicator();
  private readonly guestLimiter = new GuestRateLimiter();
  private readonly mentionedThreads = new MentionedThreadTracker();

  constructor(options: SlackBridgeOptions) {
    this.logger = options.logger.child({ bridge: 'slack' });
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.sessionApiKey = options.sessionApiKey;
    this.slackConfig = options.slackConfig ?? loadConfig();
    this.dbPath = options.dbPath;
    this.tickMs = options.tickMs;
    this.createConversationDefaults = options.createConversationDefaults;
  }

  get connected(): boolean {
    return this.app !== undefined && this.runtime !== undefined;
  }

  async start(): Promise<void> {
    if (this.connected) return;

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
      const message = event as GenericMessageEvent;
      if (message.subtype) return;

      const isDm = message.channel_type === 'im';
      if (!isDm) {
        if (!message.thread_ts || !this.mentionedThreads.isTracked(message.thread_ts)) return;
      }

      await this.processEvent(message, context.teamId, isDm, deps);
    });

    try {
      const auth = await app.client.auth.test();
      if (!auth.user_id) {
        throw new Error('Slack auth.test succeeded but returned no user_id');
      }
      this.botUserId = auth.user_id;

      const runtime = new SlackRelayRuntime({
        logger: this.logger,
        serverUrl: this.serverUrl,
        sessionApiKey: this.sessionApiKey,
        ...(this.dbPath === undefined ? {} : { dbPath: this.dbPath }),
        ...(this.tickMs === undefined ? {} : { tickMs: this.tickMs }),
        ...(this.createConversationDefaults === undefined
          ? {}
          : { createConversationDefaults: this.createConversationDefaults }),
        sendChunk: (channel, text, threadTs) => this.postChunk(channel, text, threadTs),
      });
      this.runtime = runtime;
      await runtime.start();
      await app.start();

      this.logger.info(
        {
          botUserId: this.botUserId,
          team: auth.team,
          agentServer: this.serverUrl,
          buildSha: process.env.SMOLPAWS_BUILD_SHA?.trim() || undefined,
        },
        'SmolPaws Slack bot is ready on Message Relay path 🐾',
      );
    } catch (error) {
      await this.runtime?.stop().catch(() => undefined);
      await app.stop().catch(() => undefined);
      this.runtime = undefined;
      this.app = undefined;
      this.botUserId = '';
      throw error;
    }
  }

  async stop(): Promise<void> {
    const app = this.app;
    const runtime = this.runtime;
    if (app === undefined && runtime === undefined) return;

    // Stop Socket Mode ingress first. Keep the Bolt app/client reachable while the relay waits for any
    // active tick: an already-claimed delivery may still need chat.postMessage before SQLite closes.
    await app?.stop().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Failed to stop Slack Socket Mode app cleanly');
    });
    await runtime?.stop().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Failed to stop Slack relay runtime cleanly');
    });

    if (this.app === app) this.app = undefined;
    if (this.runtime === runtime) this.runtime = undefined;
    this.botUserId = '';
  }

  private async accept(message: IncomingMessage): Promise<void> {
    const runtime = this.runtime;
    if (runtime === undefined) {
      throw new Error('Slack relay runtime is not started');
    }
    await runtime.accept(message);
  }

  private async processEvent(
    event: SlackEventLike,
    teamId: string | undefined,
    isDm: boolean,
    deps: SlackDeps,
  ): Promise<void> {
    if (!this.botUserId || !event.user) return;
    if (event.bot_id || event.user === this.botUserId) return;

    if (!teamId) {
      this.logger.warn(
        { channel: event.channel, ts: event.ts, user: event.user },
        'Slack event missing team context',
      );
      return;
    }

    const context: SlackEventContext = {
      teamId,
      channelId: event.channel,
      userId: event.user,
      ts: event.ts,
      threadTs: event.thread_ts,
      text: event.text ?? '',
      isDm,
      botUserId: this.botUserId,
    };

    await handleSlackEvent(context, deps);
  }

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
      dispatch: (message: IncomingMessage, _replyContext: ReplyContext) => this.accept(message),
    };
  }

  private async postChunk(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<string | null> {
    const app = this.app;
    if (app === undefined) throw new Error('Slack app is not connected');
    const result = await app.client.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
    return result.ts ?? null;
  }

  private async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.postChunk(channel, chunk, threadTs);
    }
  }

  private async addReaction(channel: string, timestamp: string, name: string): Promise<void> {
    const app = this.app;
    if (app === undefined) throw new Error('Slack app is not connected');
    await app.client.reactions.add({ channel, timestamp, name });
  }

  private async fetchThreadMessages(
    channel: string,
    threadTs: string,
  ): Promise<ThreadMessage[]> {
    const app = this.app;
    if (app === undefined) throw new Error('Slack app is not connected');
    const result = await app.client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    if (!result.messages) return [];

    const messages = result.messages as ReadonlyArray<SlackThreadReply>;
    const threadMessages: ThreadMessage[] = [];
    for (const message of messages) {
      const user = message.user ?? message.bot_id ?? message.username;
      if (
        user &&
        message.text &&
        message.ts &&
        isThreadContextMessageSubtype(message.subtype)
      ) {
        threadMessages.push({ user, text: message.text, ts: message.ts });
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

type SlackEventLike = {
  user?: string;
  bot_id?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  text?: string;
};
