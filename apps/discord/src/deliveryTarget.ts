import { isMedia, validateMedia, type MediaSender } from '../../../src/coordinator/outboundMedia.js';
import type { DeliverySendResult, DeliveryTarget } from '../../../src/coordinator/deliveryDispatcher.js';
import type { LaneRow } from '../../../src/coordinator/types.js';
import { splitDiscordMessage } from './handler.js';

/** Sends one chunk to a Discord channel and returns the created message id. */
export interface DiscordChunkSender {
  (channelId: string, text: string): Promise<string | null>;
}

interface DiscordDeliveryPayload {
  kind: 'current_thread_message';
  text: string;
}

export class DiscordDeliveryTarget implements DeliveryTarget {
  constructor(
    private readonly sendChunk: DiscordChunkSender,
    private readonly connected: () => boolean = () => true,
    private readonly sendMedia?: MediaSender,
  ) {}

  isReady(): boolean {
    return this.connected();
  }

  validate(lane: LaneRow, payload: unknown): void {
    if (lane.platform !== 'discord') {
      throw new Error(`DiscordDeliveryTarget cannot deliver platform ${lane.platform}`);
    }
    if (isMedia(payload)) {
      if (!this.sendMedia) throw new Error('Media sender is unavailable');
      validateMedia(payload); return;
    }
    parsePayload(payload);
  }

  async deliver(lane: LaneRow, payload: unknown): Promise<DeliverySendResult> {
    if (isMedia(payload)) return { externalMessageId: await this.sendMedia!(lane.chatId, payload, lane.threadId ?? undefined) };
    const parsed = parsePayload(payload);
    let externalMessageId: string | null = null;
    for (const chunk of splitDiscordMessage(parsed.text)) {
      externalMessageId = await this.sendChunk(lane.chatId, chunk);
    }
    return { externalMessageId };
  }
}

function parsePayload(payload: unknown): DiscordDeliveryPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('invalid Discord delivery payload');
  }
  const record = payload as Record<string, unknown>;
  if (record.kind !== 'current_thread_message' || typeof record.text !== 'string' || record.text.trim().length === 0) {
    throw new Error('invalid Discord delivery payload');
  }
  return { kind: 'current_thread_message', text: record.text };
}
