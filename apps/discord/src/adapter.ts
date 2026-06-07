/**
 * Discord channel adapter.
 *
 * Connects to Discord via discord.js, listens for messages, and dispatches
 * to the agent server through BaseChannelAdapter.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
  ChannelType,
} from 'discord.js';
import {
  BaseChannelAdapter,
  channelRegistry,
  type ChannelAdapterConfig,
  type ReplyContext,
  type IncomingMessage,
} from '../../../src/shared/channelAdapter.js';

// Discord message limit
const MAX_MESSAGE_LENGTH = 2000;

export type DiscordAdapterConfig = ChannelAdapterConfig & {
  botToken: string;
  trigger?: string;
  allowedGuilds?: Set<string>;
  allowedChannels?: Set<string>;
  allowedUsers?: Set<string>;
};

export class DiscordAdapter extends BaseChannelAdapter {
  private client?: Client;
  private readonly botToken: string;
  private readonly triggerPattern: RegExp;
  private readonly allowedGuilds: Set<string>;
  private readonly allowedChannels: Set<string>;
  private readonly allowedUsers: Set<string>;
  private botUserId = '';

  constructor(config: DiscordAdapterConfig) {
    super(config);
    this.botToken = config.botToken;
    const trigger = config.trigger || '@smolpaws';
    this.triggerPattern = new RegExp(
      trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i',
    );
    this.allowedGuilds = config.allowedGuilds ?? new Set();
    this.allowedChannels = config.allowedChannels ?? new Set();
    this.allowedUsers = config.allowedUsers ?? new Set();
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  protected async connect(): Promise<void> {
    // Fresh client per connection cycle — discord.js doesn't support
    // reusing a destroyed client, and reusing a live one would
    // accumulate duplicate event listeners.
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });

    return new Promise<void>((resolve, reject) => {
      const client = this.client!;
      client.once(Events.ClientReady, (readyClient) => {
        this.botUserId = readyClient.user.id;
        this.logger.info(
          {
            user: readyClient.user.tag,
            guilds: readyClient.guilds.cache.size,
          },
          'Discord bot ready 🐾',
        );
        resolve();
      });

      client.on(Events.MessageCreate, (message) => {
        void this.onMessage(message);
      });

      client.on(Events.Error, (error) => {
        this.logger.error({ error }, 'Discord client error');
      });

      client.login(this.botToken).catch(reject);
    });
  }

  protected async disconnect(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
  }

  // ── Platform I/O ─────────────────────────────────────────────────

  protected async sendReply(ctx: ReplyContext, text: string): Promise<void> {
    if (!text.trim()) return;
    const message = ctx.original as Message;
    for (const chunk of splitMessage(text)) {
      await message.reply({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
  }

  protected async sendTyping(ctx: ReplyContext): Promise<void> {
    const message = ctx.original as Message;
    const channel = message.channel;
    if ('sendTyping' in channel) {
      await channel.sendTyping();
    }
  }

  protected override buildCreateConversation(msg: IncomingMessage) {
    const base = super.buildCreateConversation(msg);
    return {
      ...base,
      smolpaws: {
        ...base.smolpaws,
        discord: msg.platformContext,
      },
    };
  }

  // ── Message handling ─────────────────────────────────────────────

  private async onMessage(message: Message): Promise<void> {
    if (!this.shouldRespond(message)) return;
    if (!this.isAllowed(message)) {
      await message.reply({
        content:
          "smolpaws: sorry, these paws only answer a small trusted circle. Ask Engel to add you, or set up your own little cat agent 🐾",
        allowedMentions: { parse: [] },
      }).catch(() => {});
      return;
    }

    const prompt = this.extractPrompt(message.content);
    if (!prompt) {
      await message.reply({
        content: '🐾 You called? Say something after the mention and I\'ll help.',
        allowedMentions: { parse: [] },
      }).catch(() => {});
      return;
    }

    const conversationId = this.buildConversationId(message);
    const replyCtx: ReplyContext = {
      original: message,
      conversationId,
    };

    this.logger.info(
      {
        author: message.author.tag,
        channel: message.channelId,
        guild: message.guildId,
        conversationId,
        promptLength: prompt.length,
      },
      'Processing Discord message',
    );

    try {
      await this.dispatch(
        {
          conversationId,
          prompt,
          messageId: message.id,
          platformContext: {
            guild_id: message.guildId ?? undefined,
            channel_id: message.channelId,
            author_id: message.author.id,
            author_name: message.author.tag,
          },
        },
        replyCtx,
      );
    } catch (error) {
      this.logger.error({ error, conversationId }, 'Error processing message');
      await message.reply({
        content: '🐾 Something went wrong on my end. Try again in a moment.',
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }

  private shouldRespond(message: Message): boolean {
    if (message.author.bot) return false;
    if (message.mentions.has(this.botUserId)) return true;
    if (this.triggerPattern.test(message.content)) return true;
    if (message.channel.type === ChannelType.DM) return true;
    return false;
  }

  private isAllowed(message: Message): boolean {
    if (this.allowedUsers.size > 0) {
      const username = message.author.username.trim().toLowerCase();
      const tag = message.author.tag.trim().toLowerCase();
      if (!this.allowedUsers.has(username) && !this.allowedUsers.has(tag)) {
        return false;
      }
    }
    if (message.channel.type === ChannelType.DM) return true;
    if (this.allowedGuilds.size > 0 && message.guildId && !this.allowedGuilds.has(message.guildId)) {
      return false;
    }
    if (this.allowedChannels.size > 0 && !this.allowedChannels.has(message.channelId)) {
      return false;
    }
    return true;
  }

  private extractPrompt(content: string): string {
    return content
      .replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '')
      .replace(this.triggerPattern, '')
      .trim();
  }

  private buildConversationId(message: Message): string {
    if (message.channel.type === ChannelType.DM) {
      return `discord-dm-${message.author.id}`;
    }
    if (message.channel.isThread()) {
      return `discord-thread-${message.channelId}`;
    }
    return `discord-channel-${message.channelId}`;
  }
}

// ── Message splitting ──────────────────────────────────────────────

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseSet(envValue: string | undefined): Set<string> {
  return new Set(
    (envValue || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
}

function parseLowercaseSet(envValue: string | undefined): Set<string> {
  return new Set(
    (envValue || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

// ── Register with the channel registry ─────────────────────────────

channelRegistry.register('discord', (config) => {
  const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error('DISCORD_BOT_TOKEN is required');
  }
  return new DiscordAdapter({
    ...config,
    botToken,
    trigger: process.env.DISCORD_TRIGGER || '@smolpaws',
    allowedGuilds: parseSet(process.env.DISCORD_ALLOWED_GUILDS),
    allowedChannels: parseSet(process.env.DISCORD_ALLOWED_CHANNELS),
    allowedUsers: parseLowercaseSet(process.env.DISCORD_ALLOWED_USERS),
  });
});
