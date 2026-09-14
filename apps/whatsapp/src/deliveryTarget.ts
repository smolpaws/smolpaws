import { isMedia, validateMedia, type MediaSender } from '../../../src/coordinator/outboundMedia.js';
import type { DeliverySendResult, DeliveryTarget } from '../../../src/coordinator/deliveryDispatcher.js';
import type { LaneRow } from '../../../src/coordinator/types.js';

/** Sends one text message to a chat JID and returns WhatsApp's message id. */
export interface WhatsAppTextSender {
  (chatJid: string, text: string): Promise<string | null>;
}

interface WhatsAppDeliveryPayload {
  kind: 'current_thread_message';
  text: string;
}

/** WhatsApp has a generous limit; keep sends well under it so long replies never fail mid-way. */
export const WHATSAPP_MAX_LENGTH = 4000;

export function splitWhatsAppMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= WHATSAPP_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', WHATSAPP_MAX_LENGTH);
    if (splitAt < WHATSAPP_MAX_LENGTH * 0.5) {
      const spaceSplit = remaining.lastIndexOf(' ', WHATSAPP_MAX_LENGTH);
      if (spaceSplit > splitAt) splitAt = spaceSplit;
    }
    if (splitAt < WHATSAPP_MAX_LENGTH * 0.3) splitAt = WHATSAPP_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/**
 * WhatsApp implementation of the coordinator DeliveryTarget boundary. Every outbound text carries the
 * `<assistant>: ` prefix the ledger uses to recognize the cat's own messages, because the human shares
 * the WhatsApp account and `fromMe` cannot tell them apart.
 */
export class WhatsAppDeliveryTarget implements DeliveryTarget {
  constructor(
    private readonly sendText: WhatsAppTextSender,
    private readonly assistantName: string,
    private readonly connected: () => boolean = () => true,
    private readonly sendMedia?: MediaSender,
  ) {}

  isReady(): boolean {
    return this.connected();
  }

  validate(lane: LaneRow, payload: unknown): void {
    if (lane.platform !== 'whatsapp') {
      throw new Error(`WhatsAppDeliveryTarget cannot deliver platform ${lane.platform}`);
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
    const chunks = splitWhatsAppMessage(parsed.text);
    for (const [index, chunk] of chunks.entries()) {
      const prefixed = index === 0 ? `${this.assistantName}: ${chunk}` : `${this.assistantName}: …${chunk}`;
      externalMessageId = await this.sendText(lane.chatId, prefixed);
    }
    return { externalMessageId };
  }
}

function parsePayload(payload: unknown): WhatsAppDeliveryPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('invalid WhatsApp delivery payload');
  }
  const record = payload as Record<string, unknown>;
  if (record.kind !== 'current_thread_message' || typeof record.text !== 'string' || record.text.trim().length === 0) {
    throw new Error('invalid WhatsApp delivery payload');
  }
  return { kind: 'current_thread_message', text: record.text };
}
