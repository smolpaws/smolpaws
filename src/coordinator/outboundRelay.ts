/**
 * Outbound Relay: durable agent events -> delivery outbox -> external dispatch.
 *
 * `syncDeliveryOutbox()` is the catch-up boundary. It may be called repeatedly and is safe because the
 * Message Relay owns a durable cursor plus idempotent delivery source keys. The Outbound Relay then asks
 * DeliveryDispatcher to perform bounded external side effects from the durable outbox.
 */
import type { MessageRelay } from './messageRelay.js';
import type {
  DeliveryDispatchOutcome,
  DeliveryDispatcher,
} from './deliveryDispatcher.js';

export interface OutboundRelayOptions {
  /** Durable/authoritative conversation ids that should be caught up this tick. */
  listConversationIds: () => readonly string[] | Promise<readonly string[]>;
  /** Bound external sends per tick so one busy process does not monopolize the loop. */
  maxDispatchPerTick?: number;
}

export interface OutboundRelayTickResult {
  syncedDeliveries: number;
  dispatched: number;
  syncFailures: ReadonlyArray<{ conversationId: string; error: unknown }>;
  dispatchOutcomes: readonly DeliveryDispatchOutcome[];
}

export class OutboundRelay {
  private readonly maxDispatchPerTick: number;

  constructor(
    private readonly messageRelay: MessageRelay,
    private readonly dispatcher: DeliveryDispatcher,
    private readonly options: OutboundRelayOptions,
  ) {
    this.maxDispatchPerTick = options.maxDispatchPerTick ?? 32;
  }

  /** Bring one conversation's durable agent events into its delivery outbox. */
  async syncDeliveryOutbox(conversationId: string): Promise<number> {
    return this.messageRelay.syncDeliveryOutbox(conversationId);
  }

  async tick(worker: string): Promise<OutboundRelayTickResult> {
    let syncedDeliveries = 0;
    const syncFailures: Array<{ conversationId: string; error: unknown }> = [];
    const uniqueConversationIds = new Set(await this.options.listConversationIds());

    for (const conversationId of uniqueConversationIds) {
      try {
        syncedDeliveries += await this.syncDeliveryOutbox(conversationId);
      } catch (error) {
        // One unavailable/corrupt conversation must not prevent already-durable outbox rows for other
        // lanes from being dispatched.
        syncFailures.push({ conversationId, error });
      }
    }

    const dispatchOutcomes: DeliveryDispatchOutcome[] = [];
    let dispatched = 0;
    for (let i = 0; i < this.maxDispatchPerTick; i += 1) {
      const outcome = await this.dispatcher.dispatchNext(worker);
      if (outcome.kind === 'idle') break;
      dispatchOutcomes.push(outcome);
      if (outcome.kind === 'delivered') dispatched += 1;
    }

    return { syncedDeliveries, dispatched, syncFailures, dispatchOutcomes };
  }
}
