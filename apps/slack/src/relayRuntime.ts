import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import type { Logger } from 'pino';

import { MessageRelay, finalResponseExtractor } from '../../../src/coordinator/messageRelay.js';
import { DeliveryDispatcher, DeliveryTargetRegistry } from '../../../src/coordinator/deliveryDispatcher.js';
import { HttpAgentServerClient } from '../../../src/coordinator/httpAgentServerClient.js';
import { deterministicConversationId } from '../../../src/coordinator/ids.js';
import { OutboundRelay } from '../../../src/coordinator/outboundRelay.js';
import { MessageWorkStore } from '../../../src/coordinator/store.js';
import type { IncomingMessage } from '../../../src/shared/bridgeAdapter.js';
import { SlackDeliveryTarget, type SlackChunkSender } from './deliveryTarget.js';

const SLACK_RELAY_ID_NAMESPACE = 'slack-relay:v1';
// Keep the established on-disk location during the naming migration. Renaming the product concept must
// not silently orphan an existing durable outbox.
const DEFAULT_SLACK_RELAY_DB = join(
  homedir(),
  '.smolpaws',
  'coordinator',
  'slack-relay-v1.db',
);

export interface SlackRelayRuntimeOptions {
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  sendChunk: SlackChunkSender;
  dbPath?: string;
  tickMs?: number;
  /** Extra fields used only when the Message Relay creates a new agent-server conversation. */
  createConversationDefaults?: Record<string, unknown>;
}

/**
 * Slack runtime for the durable Message Relay architecture.
 *
 * Slack ingress only durably accepts work. A local worker loop integrates intake into the
 * upstream-shaped agent-server, keeps the delivery outbox synced, and lets DeliveryDispatcher perform
 * the Slack side effect. There is deliberately no `/turns` fallback.
 */
export class SlackRelayRuntime {
  private readonly db: Database.Database;
  private readonly store: MessageWorkStore;
  private readonly messageRelay: MessageRelay;
  private readonly outboundRelay: OutboundRelay;
  private readonly logger: Logger;
  private readonly tickMs: number;
  private readonly intakeWorker = `slack-intake:${process.pid}`;
  private readonly deliveryWorker = `slack-delivery:${process.pid}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeTick: Promise<void> | null = null;
  private closed = false;

  constructor(options: SlackRelayRuntimeOptions) {
    this.logger = options.logger.child({ component: 'slack-relay-runtime' });
    this.tickMs = options.tickMs ?? 500;

    // The authoritative relay deliberately owns a new database and a versioned conversation-id
    // namespace. Earlier shadow experiments used different state but unversioned conversation ids;
    // reusing those identities could replay historical shadow responses on first cutover.
    const dbPath = options.dbPath ?? DEFAULT_SLACK_RELAY_DB;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.store = new MessageWorkStore(this.db);

    const agent = new HttpAgentServerClient({
      baseUrl: options.serverUrl,
      sessionApiKey: options.sessionApiKey,
      ...(options.createConversationDefaults === undefined
        ? {}
        : { createDefaults: options.createConversationDefaults }),
    });
    // Slack's first authoritative canary delivers the normal terminal response. The default agent
    // profile already includes FinishTool, so ordinary chat does not need a Slack-specific send tool.
    this.messageRelay = new MessageRelay(this.store, agent, {
      extractor: finalResponseExtractor,
      deriveConversationId: (descriptor) => slackRelayConversationId(descriptor.laneKey),
    });

    const targets = new DeliveryTargetRegistry();
    targets.register('slack', new SlackDeliveryTarget(options.sendChunk));
    const dispatcher = new DeliveryDispatcher(this.store, targets);
    this.outboundRelay = new OutboundRelay(this.messageRelay, dispatcher, {
      listConversationIds: () => this.listSlackConversationIds(),
      maxDispatchPerTick: 32,
    });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('SlackRelayRuntime is closed');
    if (this.timer !== null) return;
    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: errorMessage(error) }, 'Slack Message Relay tick failed');
      });
    }, this.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.activeTick?.catch(() => undefined);
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  /** Durably accept one normalized Slack message and wake the worker loop. */
  async accept(message: IncomingMessage): Promise<void> {
    if (this.closed) throw new Error('SlackRelayRuntime is closed');
    const descriptor = slackLaneDescriptor(message);
    if (message.messageId === undefined || message.messageId.length === 0) {
      throw new Error('Slack Message Relay intake requires messageId');
    }
    await this.messageRelay.acceptInbound(descriptor, {
      sourceMessageId: message.messageId,
      content: message.prompt,
    });
    // Acceptance is the durable ingress boundary. Wake the loop without waiting for the LLM run.
    void this.runOnce().catch((error: unknown) => {
      this.logger.error({ err: errorMessage(error) }, 'Slack Message Relay wake-up failed');
    });
  }

  /** Exposed for deterministic tests and operational one-shot drains. Concurrent calls coalesce. */
  runOnce(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.activeTick !== null) return this.activeTick;
    const tick = this.tick();
    this.activeTick = tick;
    return tick.finally(() => {
      if (this.activeTick === tick) this.activeTick = null;
    });
  }

  private async tick(): Promise<void> {
    const reconcile = this.store.reconcile(Date.now());
    let intakeActivity = 0;

    for (let i = 0; i < 32; i += 1) {
      const outcome = await this.messageRelay.integrateNextIntake(this.intakeWorker);
      if (outcome.kind === 'idle') break;
      intakeActivity += 1;
      if (outcome.kind === 'failed' || outcome.kind === 'retry') {
        this.logger.warn({ outcome }, 'Slack intake integration did not complete');
      }
    }

    const outbound = await this.outboundRelay.tick(this.deliveryWorker);
    for (const failure of outbound.syncFailures) {
      this.logger.warn(
        { conversationId: failure.conversationId, err: errorMessage(failure.error) },
        'Failed to sync Slack delivery outbox',
      );
    }
    for (const outcome of outbound.dispatchOutcomes) {
      if (outcome.kind === 'failed' || outcome.kind === 'delivery_unknown') {
        this.logger.warn({ outcome }, 'Slack delivery did not settle cleanly');
      }
    }

    const reconcileActivity =
      reconcile.expiredToReady + reconcile.expiredToDeliveryUnknown + reconcile.retryWaitToReady;
    if (
      intakeActivity > 0 ||
      outbound.syncedDeliveries > 0 ||
      outbound.dispatched > 0 ||
      reconcileActivity > 0
    ) {
      this.logger.info(
        {
          intakeActivity,
          syncedDeliveries: outbound.syncedDeliveries,
          dispatched: outbound.dispatched,
          reconcile,
        },
        'Slack Message Relay tick',
      );
    }
  }

  private listSlackConversationIds(): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT conversation_id FROM lanes
         WHERE platform = 'slack' AND conversation_ready = 1
         ORDER BY last_seen_at ASC`,
      )
      .all() as Array<{ conversation_id: string }>;
    return rows.map((row) => row.conversation_id);
  }
}

/** Stable conversation identity for the first authoritative Slack relay generation. */
export function slackRelayConversationId(laneKey: string): string {
  return deterministicConversationId(`${SLACK_RELAY_ID_NAMESPACE}:${laneKey}`);
}

export function slackLaneDescriptor(message: IncomingMessage) {
  const context = (message.platformContext ?? {}) as Record<string, unknown>;
  const teamId = typeof context.team_id === 'string' ? context.team_id : null;
  const channelId = typeof context.channel_id === 'string' ? context.channel_id : null;
  if (teamId === null || channelId === null) {
    throw new Error('Slack Message Relay intake requires team_id and channel_id');
  }
  const threadId =
    message.conversationId.startsWith('slack-thread-') && typeof context.thread_ts === 'string'
      ? context.thread_ts
      : null;
  return {
    laneKey: `channel:slack:${teamId}:${channelId}:${threadId ?? 'root'}`,
    platform: 'slack',
    accountId: teamId,
    chatId: channelId,
    threadId,
    displayName: message.conversationId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
