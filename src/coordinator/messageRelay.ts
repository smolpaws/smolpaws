/**
 * Message Relay core.
 *
 * Ties the durable {@link MessageWorkStore} to agent-server through a narrow injected
 * {@link AgentServerClient}. It keeps agent-server upstream-shaped: intake becomes a deterministic
 * `append + run`, and outbound work is synced from the durable EventLog into a delivery outbox.
 *
 * Responsibilities that stay OUT of agent-server: external dedup, lane↔conversation directory,
 * per-lane order, claims/retries/backoff, delivery outcome, reconciliation, and audit.
 */
import { deterministicConversationId, deterministicEventId } from './ids.js';
import type { MessageWorkStore } from './store.js';
import {
  type AgentEvent,
  type AgentServerClient,
  type DeliverableExtractor,
  type InboundMessage,
  type IntegrationOutcome,
  type LaneBinding,
  type LaneDescriptor,
  type WorkRow,
} from './types.js';

export interface MessageRelayOptions {
  /** Clock in epoch ms (injected for determinism). Defaults to Date.now. */
  now?: () => number;
  /** Derive the agent-server conversation id for a lane. Defaults to a deterministic UUIDv5. */
  deriveConversationId?: (descriptor: LaneDescriptor) => string;
  /** Derive the deterministic event id for an inbound message. Defaults to UUIDv5(platform+msgId). */
  deriveEventId?: (platform: string, sourceMessageId: string) => string;
  /** Build the unique intake dedup key. Defaults to `{platform}:{account}:{sourceMessageId}`. */
  buildIntakeSourceKey?: (descriptor: LaneDescriptor, sourceMessageId: string) => string;
  /** What counts as deliverable. Defaults to explicit send_message action events. */
  extractor?: DeliverableExtractor;
  /** Classify an append error as retryable. Defaults to retryable unless `err.nonRetryable`. */
  isRetryable?: (error: unknown) => boolean;
  /** Page size when syncing agent events into the delivery outbox. */
  outboxSyncPageSize?: number;
}

/**
 * Default extractor: create one delivery per explicit outbound-intent action the agent emitted
 * (`send_message` / `current_thread_message`). This matches tool-driven outbound behavior while keeping
 * the outbox sourced from durable events. Normal terminal responses are available through
 * {@link finalResponseExtractor}.
 */
export const sendMessageExtractor: DeliverableExtractor = (event: AgentEvent) => {
  if (event.kind !== 'ActionEvent') return null;
  const toolName = typeof event.tool_name === 'string' ? event.tool_name : undefined;
  if (toolName !== 'send_message' && toolName !== 'current_thread_message') return null;
  const action = (event.action ?? {}) as Record<string, unknown>;
  const text =
    typeof action.text === 'string'
      ? action.text
      : typeof action.message === 'string'
        ? action.message
        : undefined;
  if (text === undefined) return null;
  return { payload: { kind: 'current_thread_message', text } };
};

/** Terminal-response extractor: one delivery from a successful `finish` observation. */
export const finalResponseExtractor: DeliverableExtractor = (event: AgentEvent) => {
  if (event.kind !== 'ObservationEvent') return null;
  if (event.tool_name !== 'finish') return null;
  const observation = (event.observation ?? {}) as Record<string, unknown>;
  const text =
    typeof observation.message === 'string'
      ? observation.message
      : typeof observation.text === 'string'
        ? observation.text
        : undefined;
  if (text === undefined) return null;
  return { payload: { kind: 'current_thread_message', text } };
};

export class MessageRelay {
  private readonly store: MessageWorkStore;
  private readonly agent: AgentServerClient;
  private readonly now: () => number;
  private readonly deriveConversationId: (descriptor: LaneDescriptor) => string;
  private readonly deriveEventId: (platform: string, id: string) => string;
  private readonly buildIntakeSourceKey: (descriptor: LaneDescriptor, id: string) => string;
  private readonly extractor: DeliverableExtractor;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly outboxSyncPageSize: number;

  constructor(store: MessageWorkStore, agent: AgentServerClient, options: MessageRelayOptions = {}) {
    this.store = store;
    this.agent = agent;
    this.now = options.now ?? (() => Date.now());
    this.deriveConversationId =
      options.deriveConversationId ?? ((descriptor) => deterministicConversationId(descriptor.laneKey));
    this.deriveEventId = options.deriveEventId ?? deterministicEventId;
    this.buildIntakeSourceKey =
      options.buildIntakeSourceKey ??
      ((descriptor, id) => `${descriptor.platform}:${descriptor.accountId ?? ''}:${id}`);
    this.extractor = options.extractor ?? sendMessageExtractor;
    this.isRetryable =
      options.isRetryable ??
      ((error) => !(error as { nonRetryable?: boolean } | null)?.nonRetryable);
    this.outboxSyncPageSize = options.outboxSyncPageSize ?? 100;
  }

  /** Resolve and durably bind an external lane to one agent-server conversation. */
  async resolveLane(descriptor: LaneDescriptor): Promise<LaneBinding> {
    const now = this.now();
    const candidate = this.deriveConversationId(descriptor);
    const binding = this.store.resolveLane(descriptor, candidate, now);
    if (!binding.conversationReady) {
      await this.agent.ensureConversation(binding.conversationId);
      this.store.markLaneConversationReady(binding.laneKey, this.now());
      return { ...binding, conversationReady: true };
    }
    return binding;
  }

  /** Durably accept one normalized external message as intake work. */
  async acceptInbound(descriptor: LaneDescriptor, message: InboundMessage): Promise<WorkRow> {
    const binding = await this.resolveLane(descriptor);
    const sourceKey = this.buildIntakeSourceKey(descriptor, message.sourceMessageId);
    const agentEventId = this.deriveEventId(descriptor.platform, message.sourceMessageId);
    return this.store.acceptIntake(
      binding,
      { sourceKey, agentEventId, payload: message.content },
      this.now(),
    );
  }

  /** Claim and integrate the next ready intake lane-head into agent-server. */
  async integrateNextIntake(worker: string): Promise<IntegrationOutcome> {
    const claim = this.store.claimReady(worker, this.now(), 'intake');
    if (!claim) return { kind: 'idle' };
    const { row } = claim;
    try {
      const result = await this.agent.appendEvent(row.conversationId ?? '', {
        eventId: row.agentEventId ?? '',
        role: 'user',
        content: row.payload,
        run: true,
      });
      this.store.settle(claim, { kind: 'done' }, this.now());
      return { kind: 'integrated', workId: row.id, eventCreated: result.created };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isRetryable(error)) {
        const state = this.store.settle(claim, { kind: 'retry', error: message }, this.now());
        return state === 'failed'
          ? { kind: 'failed', workId: row.id, error: message }
          : { kind: 'retry', workId: row.id, error: message };
      }
      this.store.settle(claim, { kind: 'fail', error: message }, this.now());
      return { kind: 'failed', workId: row.id, error: message };
    }
  }

  /**
   * Bring one conversation's durable delivery outbox up to date from its agent EventLog. Resumable via
   * the per-conversation cursor; deliveries are inserted before the cursor advances so a crash replays
   * safely and the unique `(kind, source_key)` index makes re-insertion a no-op.
   */
  async syncDeliveryOutbox(conversationId: string): Promise<number> {
    const lane = this.store.getLaneByConversationId(conversationId);
    if (!lane) return 0;

    let offset = Number.parseInt(this.store.getProjectionCursor(conversationId) ?? '0', 10);
    if (Number.isNaN(offset)) offset = 0;
    let created = 0;

    for (;;) {
      const page = await this.agent.searchEvents(
        conversationId,
        String(offset),
        this.outboxSyncPageSize,
      );
      for (const event of page.items) {
        const intent = this.extractor(event);
        if (!intent) continue;
        const sourceKey = `${event.id}:${lane.laneKey}`;
        const before = this.store.getWorkBySourceKey('delivery', sourceKey);
        this.store.insertDelivery(
          {
            sourceKey,
            laneKey: lane.laneKey,
            conversationId,
            agentEventId: event.id,
            payload: intent.payload,
          },
          this.now(),
        );
        if (!before) created += 1;
      }

      offset += page.items.length;
      this.store.setProjectionCursor(conversationId, String(offset), this.now());
      if (page.nextPageId === null) break;
    }

    return created;
  }

  /** Expose the store for worker/claim/settle/reconcile access and audit reads. */
  get workStore(): MessageWorkStore {
    return this.store;
  }
}
