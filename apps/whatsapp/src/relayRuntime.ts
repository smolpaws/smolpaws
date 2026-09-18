import type { RelayCommand } from '../../../src/coordinator/relayCommands.js';
import type { MediaSender } from '../../../src/coordinator/outboundMedia.js';
import type { Logger } from 'pino';

import { bridgeResponseExtractor } from '../../../src/coordinator/messageRelay.js';
import { RelayRuntime, defaultRelayDbPath } from '../../../src/coordinator/relayRuntime.js';
import type { MessageWorkStore } from '../../../src/coordinator/store.js';
import type { LaneDescriptor } from '../../../src/coordinator/types.js';
import { WhatsAppDeliveryTarget, type WhatsAppTextSender } from './deliveryTarget.js';

export interface WhatsAppRelayRuntimeOptions {
  sendMedia?: MediaSender;
  logger: Logger;
  serverUrl: string;
  sessionApiKey?: string;
  assistantName: string;
  sendText: WhatsAppTextSender;
  /** Transport readiness; while false no delivery is claimed (see DeliveryTarget.isReady). */
  isConnected: () => boolean;
  dbPath?: string;
  tickMs?: number;
  createConversationDefaults?: Record<string, unknown>;
  createConversationDefaultsFor?: (lane: LaneDescriptor) => Record<string, unknown>;
}

/**
 * WhatsApp delivers explicit `send_message` tool actions (EXT-SDK-001, the
 * cat talking mid-task) and the terminal response (a finish observation or the end-of-turn assistant
 * text), plus conversation-error notices. Each delivery stays keyed to one durable agent event id, so
 * replay safety is unchanged.
 */
export const whatsappExtractor = bridgeResponseExtractor;

/** One relay per WhatsApp account/process with its own SQLite store. */
export class WhatsAppRelayRuntime {
  private readonly runtime: RelayRuntime;

  constructor(options: WhatsAppRelayRuntimeOptions) {
    this.runtime = new RelayRuntime({
      platform: 'whatsapp',
      logger: options.logger,
      serverUrl: options.serverUrl,
      sessionApiKey: options.sessionApiKey,
      target: new WhatsAppDeliveryTarget(options.sendText, options.assistantName, options.isConnected, options.sendMedia),
      dbPath: options.dbPath ?? defaultRelayDbPath('whatsapp'),
      extractor: whatsappExtractor,
      ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
      ...(options.createConversationDefaults === undefined
        ? {}
        : { createConversationDefaults: options.createConversationDefaults }),
      ...(options.createConversationDefaultsFor === undefined
        ? {}
        : { createConversationDefaultsFor: options.createConversationDefaultsFor }),
    });
  }

  registerLane(lane: LaneDescriptor) { return this.runtime.registerLane(lane); }
  get scheduler() { return this.runtime.scheduler; }

  get workStore(): MessageWorkStore {
    return this.runtime.workStore;
  }

  start(): Promise<void> {
    return this.runtime.start();
  }

  stop(): Promise<void> {
    return this.runtime.stop();
  }

  /** Durably accept one chat batch. `sourceMessageId` is the newest WhatsApp message id in the batch. */
  accept(lane: LaneDescriptor, sourceMessageId: string, content: unknown, command?: RelayCommand): Promise<void> {
    return this.runtime.accept({ lane, message: { sourceMessageId, content, ...(command === undefined ? {} : { command }) } });
  }

  runOnce(): Promise<void> {
    return this.runtime.runOnce();
  }
}
