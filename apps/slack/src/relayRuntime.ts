import type { MediaSender } from '../../../src/coordinator/outboundMedia.js';
import type { Logger } from 'pino';

import { deterministicConversationId } from '../../../src/coordinator/ids.js';
import { RelayRuntime, defaultRelayDbPath } from '../../../src/coordinator/relayRuntime.js';
import type { MessageWorkStore } from '../../../src/coordinator/store.js';
import type { IncomingMessage } from '../../../src/shared/bridgeAdapter.js';
import { SlackDeliveryTarget, type SlackChunkSender } from './deliveryTarget.js';

const SLACK_RELAY_ID_NAMESPACE = 'slack-relay:v1';

export interface SlackRelayRuntimeOptions {
  sendMedia?: MediaSender;
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
 * Slack ingress only durably accepts work. The shared {@link RelayRuntime} worker loop integrates intake
 * into the upstream-shaped agent-server, keeps the delivery outbox synced, and lets DeliveryDispatcher
 * perform the Slack side effect. There is deliberately no `/turns` fallback.
 */
export class SlackRelayRuntime {
  private readonly runtime: RelayRuntime;

  constructor(options: SlackRelayRuntimeOptions) {
    // The authoritative relay deliberately owns a new database and a versioned conversation-id
    // namespace. Earlier shadow experiments used different state but unversioned conversation ids;
    // reusing those identities could replay historical shadow responses on first cutover.
    // The shared extractor delivers explicit sends, terminal replies, and conversation-error notices.
    this.runtime = new RelayRuntime({
      platform: 'slack',
      deriveConversationId: (lane) => slackRelayConversationId(lane.laneKey),
      logger: options.logger,
      serverUrl: options.serverUrl,
      sessionApiKey: options.sessionApiKey,
      target: new SlackDeliveryTarget(options.sendChunk, options.sendMedia),
      dbPath: options.dbPath ?? defaultRelayDbPath('slack'),
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      ...(options.createConversationDefaults === undefined
        ? {}
        : { createConversationDefaults: options.createConversationDefaults }),
    });
  }

  get workStore(): MessageWorkStore {
    return this.runtime.workStore;
  }

  start(): Promise<void> {
    return this.runtime.start();
  }

  stop(): Promise<void> {
    return this.runtime.stop();
  }

  /** Durably accept one normalized Slack message and wake the worker loop. */
  async accept(message: IncomingMessage): Promise<void> {
    if (message.messageId === undefined || message.messageId.length === 0) {
      throw new Error('Slack Message Relay intake requires messageId');
    }
    await this.runtime.accept({
      lane: slackLaneDescriptor(message),
      message: { sourceMessageId: message.messageId, content: message.prompt, ...(message.command === undefined ? {} : { command: message.command }) },
    });
  }

  /** Exposed for deterministic tests and operational one-shot drains. Concurrent calls coalesce. */
  runOnce(): Promise<void> {
    return this.runtime.runOnce();
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
