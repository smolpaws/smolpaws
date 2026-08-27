/**
 * Base bridge adapter and registry for SmolPaws ingress apps.
 *
 * A bridge connects a messaging platform (Discord, Slack, etc.)
 * to the agent server. The base class handles the agent-server dispatch
 * loop; subclasses implement platform-specific I/O.
 *
 * Minimal contract:
 *   - connect()     → start listening for platform events
 *   - disconnect()  → clean shutdown
 *   - sendReply()   → deliver agent response to the platform
 *   - sendTyping()  → show typing indicator (optional)
 *
 * Usage:
 *   class DiscordAdapter extends BaseBridgeAdapter { ... }
 *   bridgeRegistry.register('discord', (config) => new DiscordAdapter(config));
 */

import type { Logger } from 'pino';
import type { SmolpawsOutboundMessage } from './runner.js';
import { getSharedShadowIntake, isShadowEnabled } from './shadowIntake.js';
import {
  createDeliveryOwnerId,
  monitorTurn,
  submitConversationMessage,
  type ConversationMessagePayload,
} from './turnClient.js';

// ── Types ──────────────────────────────────────────────────────────────

export type BridgeAdapterConfig = {
  /** Adapter name (e.g. 'discord', 'slack'). */
  name: string;
  /** Agent-server base URL. */
  runnerUrl: string;
  /** Agent-server auth token (optional for local). */
  runnerToken?: string;
  /** Logger instance. */
  logger: Logger;
};

export type IncomingMessage = {
  /** Stable conversation ID for agent-server (e.g. 'discord-dm-12345'). */
  conversationId: string;
  /** The user's prompt text, stripped of triggers/mentions. */
  prompt: string;
  /** Platform message ID for idempotency. */
  messageId?: string;
  /** Platform-specific metadata passed to createConversation. */
  platformContext?: Record<string, unknown>;
};

export type ReplyContext = {
  /** The original incoming message — adapter stores whatever it needs. */
  // Platform-specific original message — subclasses cast at use sites.
  original: unknown;
  /** Conversation ID for logging. */
  conversationId: string;
};

export type CreateConversationOptions = {
  agent?: {
    llm?: Record<string, unknown>;
    tools?: ReadonlyArray<{ name: string }>;
  };
  confirmation_policy?: { kind: string };
  smolpaws?: Record<string, unknown>;
};

// ── Base Adapter ───────────────────────────────────────────────────────

const DEFAULT_TOOLS = [
  { name: 'terminal' },
  { name: 'file_editor' },
  { name: 'task_tracker' },
] as const;

export abstract class BaseBridgeAdapter {
  readonly name: string;
  protected readonly runnerUrl: string;
  protected readonly runnerToken?: string;
  protected readonly logger: Logger;
  private _connected = false;

  constructor(config: BridgeAdapterConfig) {
    this.name = config.name;
    this.runnerUrl = config.runnerUrl.replace(/\/+$/, '');
    this.runnerToken = config.runnerToken;
    this.logger = config.logger.child({ adapter: config.name });
  }

  get connected(): boolean {
    return this._connected;
  }

  /** Start the platform connection. Subclasses do platform-specific setup. */
  async start(): Promise<void> {
    this.logger.info({ adapter: this.name }, 'Connecting');
    await this.connect();
    this._connected = true;
    this.logger.info({ adapter: this.name, runnerUrl: this.runnerUrl }, 'Connected');
  }

  /** Stop the platform connection. */
  async stop(): Promise<void> {
    this.logger.info({ adapter: this.name }, 'Disconnecting');
    await this.disconnect();
    this._connected = false;
    this.logger.info({ adapter: this.name }, 'Disconnected');
  }

  // ── Subclass contract ──────────────────────────────────────────────

  /** Establish the platform connection (login, start listeners). */
  protected abstract connect(): Promise<void>;

  /** Tear down the platform connection. */
  protected abstract disconnect(): Promise<void>;

  /** Send a text reply back to the platform. Called once per chunk. */
  protected abstract sendReply(ctx: ReplyContext, text: string): Promise<void>;

  /** Show a typing indicator. Override if the platform supports it. */
  protected sendTyping(_ctx: ReplyContext): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Build the createConversation payload for new conversations.
   * Override to add platform-specific agent config, tools, or metadata.
   */
  protected buildCreateConversation(
    _msg: IncomingMessage,
  ): CreateConversationOptions {
    return {
      agent: { llm: {}, tools: DEFAULT_TOOLS },
      confirmation_policy: { kind: 'NeverConfirm' },
      smolpaws: {
        ingress: this.name,
        enable_send_message: true,
        ...(_msg.platformContext ?? {}),
      },
    };
  }

  // ── Agent-server dispatch (shared) ─────────────────────────────────

  /**
   * Dispatch an incoming message to the agent server, stream typing
   * indicators, and deliver the response via sendReply().
   *
   * Subclasses call this from their platform event handler.
   */
  /**
   * Fire-and-forget SHADOW intake (ADR step 3): when `SMOLPAWS_COORD_SHADOW=1` and this ingress is
   * shadow-enabled (Slack only), ALSO forward the message to the Message-Work Coordinator on the new
   * server. Additive and OFF by default — when disabled this returns before constructing anything. It is
   * never awaited and `accept()` never throws, so it cannot affect the real dispatch below or the user.
   */
  private emitShadowIntake(msg: IncomingMessage): void {
    if (!isShadowEnabled(this.name)) return;
    const shadow = getSharedShadowIntake(this.logger);
    if (shadow === null) return;
    void shadow.accept(msg);
  }

  protected async dispatch(
    msg: IncomingMessage,
    replyCtx: ReplyContext,
  ): Promise<void> {
    this.emitShadowIntake(msg);

    const deliveryOwnerId = createDeliveryOwnerId();
    const userMessage: ConversationMessagePayload = {
      role: 'user',
      content: [{ type: 'text', text: msg.prompt }],
      run: true,
    };

    // Start typing
    const typingInterval = setInterval(() => {
      void this.sendTyping(replyCtx).catch(() => {});
    }, 8000);

    try {
      await this.sendTyping(replyCtx).catch(() => {});
      const submitResult = await submitConversationMessage({
        baseUrl: this.runnerUrl,
        authToken: this.runnerToken,
        conversationId: msg.conversationId,
        idempotencyKey: msg.messageId ?? deliveryOwnerId,
        deliveryOwnerId,
        userMessage,
        createConversation: this.buildCreateConversation(msg),
      });

      this.logger.debug(
        {
          conversationId: submitResult.conversation_id,
          turnId: submitResult.turn_id,
          isDeliveryOwner: submitResult.is_delivery_owner,
        },
        'Turn submitted',
      );

      const outbound: SmolpawsOutboundMessage[] = [];
      const monitored = await monitorTurn({
        baseUrl: this.runnerUrl,
        authToken: this.runnerToken,
        conversationId: submitResult.conversation_id,
        turnId: submitResult.turn_id,
        deliveryOwnerId,
        isDeliveryOwner: submitResult.is_delivery_owner,
        onOutboundMessage: async (m) => {
          outbound.push(m);
        },
      });

      if (!monitored.isDeliveryOwner) return;

      // Deliver outbound messages first (send_message tool results)
      for (const m of outbound) {
        if (m.kind === 'current_thread_message') {
          await this.sendReply(replyCtx, m.text);
        }
      }
      // Fall back to the final reply if no outbound messages
      if (outbound.length === 0 && monitored.reply) {
        await this.sendReply(replyCtx, monitored.reply);
      } else if (outbound.length === 0 && !monitored.reply) {
        this.logger.warn({ conversationId: msg.conversationId }, 'No reply from agent');
        await this.sendReply(replyCtx, '🐾 Done — nothing to report back.');
      }
    } finally {
      clearInterval(typingInterval);
    }
  }
}

// ── Bridge Registry ─────────────────────────────────────────────────

export type BridgeAdapterFactory = (config: BridgeAdapterConfig) => BaseBridgeAdapter;

class BridgeRegistry {
  private _factories = new Map<string, BridgeAdapterFactory>();
  private _instances = new Map<string, BaseBridgeAdapter>();
  private _pending = new Set<string>();

  register(name: string, factory: BridgeAdapterFactory): void {
    this._factories.set(name, factory);
  }

  get(name: string): BridgeAdapterFactory | undefined {
    return this._factories.get(name);
  }

  has(name: string): boolean {
    return this._factories.has(name);
  }

  names(): string[] {
    return [...this._factories.keys()];
  }

  /** Create and start an adapter. Stores the instance for shutdown. */
  async startAdapter(name: string, config: Omit<BridgeAdapterConfig, 'name'>): Promise<BaseBridgeAdapter> {
    if (this._instances.has(name) || this._pending.has(name)) {
      throw new Error(`Adapter '${name}' is already running`);
    }
    const factory = this._factories.get(name);
    if (!factory) {
      throw new Error(`No adapter registered for '${name}'`);
    }
    const adapter = factory({ ...config, name });
    this._pending.add(name);
    try {
      await adapter.start();
      this._instances.set(name, adapter);
      return adapter;
    } catch (error) {
      // Cleanup partially-initialized adapter (e.g. Discord client
      // may have started background connection before the failure).
      await adapter.stop().catch(() => {});
      throw error;
    } finally {
      this._pending.delete(name);
    }
  }

  /** Stop a running adapter. */
  async stopAdapter(name: string): Promise<void> {
    const adapter = this._instances.get(name);
    if (adapter) {
      this._instances.delete(name);
      await adapter.stop();
    }
  }

  /** Stop all running adapters. */
  async stopAll(): Promise<void> {
    const stops = [...this._instances.keys()].map((n) => this.stopAdapter(n));
    await Promise.allSettled(stops);
  }

  /** Get a running adapter instance. */
  getInstance(name: string): BaseBridgeAdapter | undefined {
    return this._instances.get(name);
  }
}

/** Module-level singleton registry. */
export const bridgeRegistry = new BridgeRegistry();
