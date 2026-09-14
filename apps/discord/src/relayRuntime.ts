import type { MediaSender } from '../../../src/coordinator/outboundMedia.js';
import type { Logger } from 'pino';

import { RelayRuntime, defaultRelayDbPath } from '../../../src/coordinator/relayRuntime.js';
import type { MessageWorkStore } from '../../../src/coordinator/store.js';
import type { LaneDescriptor } from '../../../src/coordinator/types.js';
import { DiscordDeliveryTarget, type DiscordChunkSender } from './deliveryTarget.js';

export interface DiscordRelayRuntimeOptions {
  sendMedia?: MediaSender;
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  sendChunk: DiscordChunkSender;
  /** Transport readiness; while false no delivery is claimed (see DeliveryTarget.isReady). */
  isConnected: () => boolean;
  dbPath?: string;
  tickMs?: number;
  createConversationDefaults?: Record<string, unknown>;
}

/** Discord over the shared Message Relay with its own store. */
export class DiscordRelayRuntime {
  private readonly runtime: RelayRuntime;

  constructor(options: DiscordRelayRuntimeOptions) {
    this.runtime = new RelayRuntime({
      platform: 'discord',
      logger: options.logger,
      serverUrl: options.serverUrl,
      sessionApiKey: options.sessionApiKey,
      target: new DiscordDeliveryTarget(options.sendChunk, options.isConnected, options.sendMedia),
      dbPath: options.dbPath ?? defaultRelayDbPath('discord'),
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

  accept(lane: LaneDescriptor, sourceMessageId: string, content: string): Promise<void> {
    return this.runtime.accept({ lane, message: { sourceMessageId, content } });
  }

  runOnce(): Promise<void> {
    return this.runtime.runOnce();
  }
}
