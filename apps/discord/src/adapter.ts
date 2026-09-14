/**
 * Standalone Discord bridge for the durable Message Relay architecture.
 *
 * Owns the discord.js Gateway client and hands authorized, addressed messages to the shared Message
 * Relay; replies come back through {@link DiscordDeliveryTarget}. Same shape as `apps/slack` and
 * `apps/whatsapp`: own process, no `BaseBridgeAdapter`, no `/turns`.
 */
import { ChannelType, Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js';
import type { Logger } from 'pino';

import { loadConfig, type DiscordConfig } from './config.js';
import {
  extractPrompt,
  isDiscordMessageAllowed,
  laneDescriptorFor,
  shouldRespond,
  type DiscordEventContext,
} from './handler.js';
import { DiscordRelayRuntime } from './relayRuntime.js';

export { isDiscordMessageAllowed } from './handler.js';

/** The slice of a discord.js client the bridge uses; tests provide a fake. */
export interface DiscordClientLike {
  login(token: string): Promise<unknown>;
  destroy(): unknown;
  once(event: 'clientReady' | 'ready', handler: (client: { user: { id: string; tag: string } }) => void): unknown;
  on(event: 'messageCreate', handler: (message: DiscordMessageLike) => void): unknown;
  on(event: 'error', handler: (error: unknown) => void): unknown;
  channels: { fetch(channelId: string): Promise<DiscordChannelLike | null> };
}

export interface DiscordChannelLike {
  send(options: { content?: string; files?: { attachment: string; name: string }[]; allowedMentions: { parse: never[] } }): Promise<{ id: string }>;
  sendTyping?: () => Promise<unknown>;
}

/** What the bridge reads from a discord.js Message. */
export interface DiscordMessageLike {
  id: string;
  content: string;
  channelId: string;
  guildId: string | null;
  author: { id: string; tag: string; bot: boolean };
  channel: { type: number; isThread(): boolean; sendTyping?: () => Promise<unknown> };
  mentions: { has(userId: string): boolean };
  reply(options: { content: string; allowedMentions: { parse: never[] } }): Promise<unknown>;
}

export interface DiscordBridgeOptions {
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  config?: DiscordConfig;
  dbPath?: string;
  tickMs?: number;
  createConversationDefaults?: Record<string, unknown>;
  clientFactory?: () => DiscordClientLike;
}

export function createDiscordClient(): DiscordClientLike {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  }) as unknown as DiscordClientLike;
}

export class DiscordBridge {
  private readonly logger: Logger;
  private readonly serverUrl: string;
  private readonly sessionApiKey: string | undefined;
  private readonly config: DiscordConfig;
  private readonly dbPath: string | undefined;
  private readonly tickMs: number | undefined;
  private readonly createConversationDefaults: Record<string, unknown> | undefined;
  private readonly clientFactory: () => DiscordClientLike;
  private client: DiscordClientLike | undefined;
  private runtime: DiscordRelayRuntime | undefined;
  private botUserId = '';
  /** True from `clientReady` until stop; gates outbound dispatch (DeliveryTarget.isReady). */
  private clientReady = false;

  constructor(options: DiscordBridgeOptions) {
    this.logger = options.logger.child({ bridge: 'discord' });
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.sessionApiKey = options.sessionApiKey;
    this.config = options.config ?? loadConfig(process.env, (message) => this.logger.warn(message));
    this.dbPath = options.dbPath;
    this.tickMs = options.tickMs;
    this.createConversationDefaults = options.createConversationDefaults;
    this.clientFactory = options.clientFactory ?? createDiscordClient;
  }

  get connected(): boolean {
    return this.client !== undefined && this.runtime !== undefined;
  }

  /**
   * Log in first, start the relay worker only once the client is ready: queued deliveries from a
   * previous run are never attempted against a client that is not connected.
   */
  async start(): Promise<void> {
    if (this.connected) return;
    const runtime = new DiscordRelayRuntime({
      logger: this.logger,
      serverUrl: this.serverUrl,
      sessionApiKey: this.sessionApiKey,
      sendChunk: (channelId, text) => this.sendChunk(channelId, text),
      sendMedia: async (channelId, media) => {
        const channel = await this.client?.channels.fetch(channelId);
        if (!channel) throw new Error('Discord channel is unavailable');
        const sent = await channel.send({ content: media.caption, files: [{ attachment: media.path, name: media.fileName }], allowedMentions: { parse: [] } });
        return sent.id;
      },
      isConnected: () => this.clientReady,
      ...(this.dbPath === undefined ? {} : { dbPath: this.dbPath }),
      ...(this.tickMs === undefined ? {} : { tickMs: this.tickMs }),
      ...(this.createConversationDefaults === undefined ? {} : { createConversationDefaults: this.createConversationDefaults }),
    });

    // Fresh client per connection: discord.js cannot reuse a destroyed client.
    const client = this.clientFactory();
    this.client = client;
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('clientReady', (ready) => {
          this.botUserId = ready.user.id;
          this.clientReady = true;
          this.logger.info(
            { user: ready.user.tag, agentServer: this.serverUrl, buildSha: process.env.SMOLPAWS_BUILD_SHA?.trim() || undefined },
            'SmolPaws Discord bot is ready on Message Relay path 🐾',
          );
          resolve();
        });
        client.on('messageCreate', (message) => {
          void this.onMessage(message).catch((error: unknown) => {
            this.logger.error({ err: error }, 'Error processing Discord message');
          });
        });
        client.on('error', (error) => {
          this.logger.error({ err: error }, 'Discord client error');
        });
        client.login(this.config.botToken).catch(reject);
      });
      this.runtime = runtime;
      await runtime.start();
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      client.destroy();
      this.client = undefined;
      this.clientReady = false;
      this.runtime = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Stop the relay first so an in-flight delivery can still use the client, then disconnect.
    await this.runtime?.stop().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Failed to stop Discord relay runtime cleanly');
    });
    this.client?.destroy();
    this.client = undefined;
    this.clientReady = false;
    this.runtime = undefined;
    this.botUserId = '';
  }

  /** Exposed for tests: feed one message through the same path the gateway uses. */
  async onMessage(message: DiscordMessageLike): Promise<void> {
    const runtime = this.runtime;
    if (runtime === undefined || !this.botUserId) return;
    const ctx: DiscordEventContext = {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      isDirectMessage: message.channel.type === ChannelType.DM,
      isThread: message.channel.isThread(),
      authorId: message.author.id,
      authorTag: message.author.tag,
      authorIsBot: message.author.bot,
      content: message.content,
      mentionsBot: message.mentions.has(this.botUserId),
    };
    if (!shouldRespond(ctx, this.config.triggerPattern)) return;
    if (!isDiscordMessageAllowed(
      { userId: ctx.authorId, guildId: ctx.guildId, channelId: ctx.channelId, isDirectMessage: ctx.isDirectMessage },
      this.config,
    )) {
      await message.reply({
        content: 'smolpaws: sorry, these paws only answer a small trusted circle. Ask Engel to add you, or set up your own little cat agent 🐾',
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
      return;
    }

    const prompt = extractPrompt(ctx.content, this.botUserId, this.config.triggerPattern);
    if (!prompt) {
      await message.reply({ content: '🐾 You called? Say something after the mention and I\'ll help.', allowedMentions: { parse: [] } }).catch(() => undefined);
      return;
    }

    const lane = laneDescriptorFor(ctx, this.botUserId);
    this.logger.info({ author: ctx.authorTag, channel: ctx.channelId, guild: ctx.guildId, lane: lane.laneKey, promptLength: prompt.length }, 'Processing Discord message');
    await message.channel.sendTyping?.().catch(() => undefined);
    try {
      await runtime.accept(lane, ctx.messageId, prompt);
    } catch (error) {
      this.logger.error({ err: error, lane: lane.laneKey }, 'Discord intake was not durably accepted');
      await message.reply({ content: '🐾 Something went wrong on my end. Try again in a moment.', allowedMentions: { parse: [] } }).catch(() => undefined);
    }
  }

  private async sendChunk(channelId: string, text: string): Promise<string | null> {
    const client = this.client;
    if (client === undefined) throw new Error('Discord client is not connected');
    const channel = await client.channels.fetch(channelId);
    if (channel === null) throw new Error(`Discord channel not found: ${channelId}`);
    const sent = await channel.send({ content: text, allowedMentions: { parse: [] } });
    return sent.id ?? null;
  }
}

export type { Message as DiscordJsMessage };
