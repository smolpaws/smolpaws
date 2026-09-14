import { isMedia, validateMedia, type MediaSender } from '../../../src/coordinator/outboundMedia.js';
import type { LaneRow } from '../../../src/coordinator/types.js';
import type {
  DeliverySendResult,
  DeliveryTarget,
} from '../../../src/coordinator/deliveryDispatcher.js';
import { splitMessage } from './slackHandler.js';

export interface SlackChunkSender {
  (channel: string, text: string, threadTs?: string): Promise<string | null>;
}

interface SlackDeliveryPayload {
  kind: 'current_thread_message';
  text: string;
}

/** Slack implementation of the coordinator DeliveryTarget boundary. */
export class SlackDeliveryTarget implements DeliveryTarget {
  constructor(private readonly sendChunk: SlackChunkSender, private readonly sendMedia?: MediaSender) {}

  validate(lane: LaneRow, payload: unknown): void {
    if (lane.platform !== 'slack') {
      throw new Error(`SlackDeliveryTarget cannot deliver platform ${lane.platform}`);
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
    for (const chunk of splitMessage(parsed.text)) {
      externalMessageId = await this.sendChunk(
        lane.chatId,
        chunk,
        lane.threadId ?? undefined,
      );
    }
    return { externalMessageId };
  }
}

function parsePayload(payload: unknown): SlackDeliveryPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('invalid Slack delivery payload');
  }
  const record = payload as Record<string, unknown>;
  if (record.kind !== 'current_thread_message' || typeof record.text !== 'string') {
    throw new Error('invalid Slack delivery payload');
  }
  return { kind: 'current_thread_message', text: record.text };
}
