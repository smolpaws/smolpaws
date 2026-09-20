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
import { CONDENSE_REQUEST_TIMEOUT_MS, commandRejectionReason, type CommandResult, type CommandRejectionReason } from './relayCommands.js';
import type { ClaimedWork } from './types.js';
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
  commandTimeoutMs?: number;
  onCommandError?: (error: unknown) => void;
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
  onEvent?: (conversationId: string, event: AgentEvent) => void;
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

/**
 * True when an agent-server error means the conversation no longer exists (HTTP 404). Such an error is
 * permanent for this conversation, so the projector parks its cursor instead of retrying every tick.
 * Recognizes both the coordinator's `HttpAgentServerError` (a `status` field) and a plain `.status`.
 */
function isConversationAbsentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404;
}

/** Terminal-response extractor: one delivery from a nonblank `finish` observation. */
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
  if (text === undefined || text.trim().length === 0) return null;
  return { payload: { kind: 'current_thread_message', text } };
};

/**
 * Extract the plain text of an assistant {@link AgentEvent} MessageEvent that carries no tool calls,
 * i.e. the model answered directly instead of invoking a tool. Returns null for anything else.
 */
function assistantTextMessage(event: AgentEvent): string | null {
  if (event.kind !== 'MessageEvent') return null;
  const message = (event.llm_message ?? {}) as Record<string, unknown>;
  if (message.role !== 'assistant') return null;
  // A message that also drives a tool call is an intermediate step, not a terminal reply.
  const toolCalls = message.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((item): item is { text: string } =>
      typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Terminal-response extractor that also delivers plain chat replies.
 *
 * Delivers one message from either (a) a successful `finish` observation, or (b) an assistant
 * `MessageEvent` with no tool calls — the end-of-turn text a conversational model produces when it
 * answers directly instead of calling `finish`. Every delivery is still keyed to a single durable
 * agent event id, so idempotency and replay-safety are unchanged.
 *
 * This mirrors the agent-server's own `agent_final_response` logic (finish message OR last assistant
 * text) while keeping the outbox event-sourced rather than fetching a derived string.
 */
export const terminalResponseExtractor: DeliverableExtractor = (event: AgentEvent) => {
  const finish = finalResponseExtractor(event);
  if (finish !== null) return finish;
  const text = assistantTextMessage(event);
  if (text === null) return null;
  return { payload: { kind: 'current_thread_message', text } };
};

/**
 * A conversation-level error needs a visible notice, whether or not it ends the run. Tool errors
 * remain available to the agent to recover from. Never relay raw error details: they
 * can contain credentials, request bodies, or private provider URLs.
 */
export const conversationErrorExtractor: DeliverableExtractor = (event: AgentEvent) => {
  if (event.kind !== 'ConversationErrorEvent') return null;
  let text = 'I encountered a conversation error. Send another message to try continuing.';
  if (event.code === 'MaxIterationsReached') {
    const match = typeof event.detail === 'string'
      ? /^Agent reached maximum iterations limit \(([1-9]\d{0,15})\)\.$/.exec(event.detail)
      : null;
    const steps = match === null ? NaN : Number(match[1]);
    const limit = Number.isSafeInteger(steps) ? `${steps}-step` : 'step';
    text = `I stopped because this run reached its ${limit} limit. Send another message to continue.`;
  }
  return { payload: { kind: 'current_thread_message', text } };
};

/** Deliver explicit sends, terminal replies, and conversation failures through the shared outbox. */
export const bridgeResponseExtractor: DeliverableExtractor = (event: AgentEvent) =>
  sendMessageExtractor(event) ?? terminalResponseExtractor(event) ?? conversationErrorExtractor(event);

function deliveryText(payload: unknown): string | null {
  const value = payload as { kind?: unknown; text?: unknown } | null;
  return value?.kind === 'current_thread_message' && typeof value.text === 'string' ? value.text.trim() : null;
}

export class MessageRelay {
  private readonly commands = new Set<Promise<void>>();
  private readonly commandTimeoutMs: number;
  private readonly onCommandError: MessageRelayOptions['onCommandError'];
  private readonly store: MessageWorkStore;
  private readonly agent: AgentServerClient;
  private readonly now: () => number;
  private readonly deriveConversationId: (descriptor: LaneDescriptor) => string;
  private readonly deriveEventId: (platform: string, id: string) => string;
  private readonly buildIntakeSourceKey: (descriptor: LaneDescriptor, id: string) => string;
  private readonly extractor: DeliverableExtractor;
  private readonly isRetryable: (error: unknown) => boolean;
  private readonly outboxSyncPageSize: number;
  private readonly onEvent: MessageRelayOptions['onEvent'];

  constructor(store: MessageWorkStore, agent: AgentServerClient, options: MessageRelayOptions = {}) {
    this.store = store;
    this.commandTimeoutMs = options.commandTimeoutMs ?? CONDENSE_REQUEST_TIMEOUT_MS;
    this.onCommandError = options.onCommandError;
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
    this.onEvent = options.onEvent;
    this.outboxSyncPageSize = options.outboxSyncPageSize ?? 100;
  }

  /** Resolve and durably bind an external lane to one agent-server conversation. */
  async resolveLane(descriptor: LaneDescriptor): Promise<LaneBinding> {
    const now = this.now();
    const candidate = this.deriveConversationId(descriptor);
    const binding = this.store.resolveLane(descriptor, candidate, now);
    if (!binding.conversationReady) {
      await this.agent.ensureConversation(binding.conversationId, descriptor);
      this.store.markLaneConversationReady(binding.laneKey, this.now());
      return { ...binding, conversationReady: true };
    }
    return binding;
  }

  /** Durably accept one normalized external message as intake work. */
  async acceptInbound(descriptor: LaneDescriptor, message: InboundMessage): Promise<WorkRow> {
    const binding = this.store.resolveLane(descriptor, this.deriveConversationId(descriptor), this.now());
    const sourceKey = this.buildIntakeSourceKey(descriptor, message.sourceMessageId);
    const agentEventId = this.deriveEventId(descriptor.platform, message.sourceMessageId);
    return this.store.acceptIntake(
      binding.laneKey,
      { sourceKey, agentEventId, payload: message.content, ...(message.command === undefined ? {} : { command: message.command }) },
      this.now(),
    );
  }

  /** Claim and integrate the next ready intake lane-head into agent-server. */
  async integrateNextIntake(worker: string): Promise<IntegrationOutcome> {
    const claim = this.store.claimReady(worker, this.now(), 'intake');
    if (!claim) return { kind: 'idle' };
    const { row } = claim;
    try {
      const lane = this.store.getLane(row.laneKey);
      if (!lane) throw new Error(`work references unknown lane: ${row.laneKey}`);
      if (!lane.conversationReady) {
        await this.agent.ensureConversation(lane.conversationId, lane);
        this.store.markLaneConversationReady(lane.laneKey, this.now());
      }
      if (this.store.getCommand(row.id) !== null) {
        if (this.store.startCommand(claim, this.now(), this.commandTimeoutMs)) {
          const operation = this.performCommand(claim, lane.conversationId);
          this.commands.add(operation);
          void operation.finally(() => this.commands.delete(operation)).catch(error => this.onCommandError?.(error));
        }
        return { kind: 'command_started', workId: row.id };
      }
      const result = await this.agent.appendEvent(lane.conversationId, {
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
        return state === 'failed' || state === 'done'
          ? { kind: 'failed', workId: row.id, error: message }
          : { kind: 'retry', workId: row.id, error: message };
      }
      if (this.store.getCommand(row.id)?.status === 'pending') {
        this.store.finishCommand(claim, 'rejected', this.now());
      } else this.store.settle(claim, { kind: 'fail', error: message }, this.now());
      return { kind: 'failed', workId: row.id, error: message };
    }
  }

  /** Stop waits for bounded maintenance operations before closing the shared SQLite connection. */
  async whenCommandsIdle(): Promise<void> {
    while (this.commands.size) await Promise.allSettled([...this.commands]);
  }

  private async performCommand(claim: ClaimedWork, conversationId: string): Promise<void> {
    let result: CommandResult = 'rejected';
    let reason: CommandRejectionReason | undefined;
    if (this.agent.condense !== undefined) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.agent.condense(conversationId, controller.signal),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(new Error('Condensation outcome unconfirmed'));
          }, this.commandTimeoutMs); }),
        ]);
        result = 'succeeded';
      } catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        // A definite rejection can be reported without exposing backend/provider response bodies.
        // Timeouts/network/5xx cannot prove whether the server applied condensation.
        result = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'unknown';
        if (result === 'rejected') reason = commandRejectionReason(error);
      } finally { if (timer) clearTimeout(timer); }
    }
    this.store.finishCommand(claim, result, this.now(), reason);
  }

  /**
   * Bring one conversation's durable delivery outbox up to date from its agent EventLog. Resumable via
   * the per-conversation cursor; deliveries are inserted before the cursor advances so a crash replays
   * safely and the unique `(kind, source_key)` index makes re-insertion a no-op.
   */
  async syncDeliveryOutbox(conversationId: string): Promise<number> {
    const lane = this.store.getLaneByConversationId(conversationId);
    if (!lane) return 0;

    // A parked cursor means the agent-server no longer has this conversation. Skip it so a
    // permanently-absent conversation cannot spin the outbound tick on 404s forever. It stays
    // parked until a reconciliation explicitly un-parks it.
    if (this.store.isProjectionCursorParked(conversationId)) return 0;

    let offset = Number.parseInt(this.store.getProjectionCursor(conversationId) ?? '0', 10);
    if (Number.isNaN(offset)) offset = 0;
    let created = 0;

    for (;;) {
      let page: { items: AgentEvent[]; nextPageId: string | null };
      try {
        page = await this.agent.searchEvents(
          conversationId,
          String(offset),
          this.outboxSyncPageSize,
        );
      } catch (error) {
        // The conversation is gone from the agent-server (404): park the cursor and stop, rather
        // than re-throwing every tick. Any other error (transient 5xx / network) propagates so the
        // outbound tick records it as a retryable sync failure.
        if (isConversationAbsentError(error)) {
          this.store.parkProjectionCursor(conversationId, this.now());
          return created;
        }
        throw error;
      }
      for (const [index, event] of page.items.entries()) {
        this.onEvent?.(conversationId, event);
        const intent = this.extractor(event);
        if (!intent) continue;
        const text = deliveryText(intent.payload);
        if (text !== null && terminalResponseExtractor(event) !== null &&
            await this.isQueuedFinalEcho(conversationId, lane.laneKey, text, offset, page.items.slice(0, index))) continue;
        const sourceKey = `${event.id}:${lane.laneKey}`;
        const before = this.store.getWorkBySourceKey('delivery', sourceKey);
        this.store.insertDelivery(
          {
            sourceKey,
            laneKey: lane.laneKey,
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

  /** Consult durable history/outbox, so suppression survives paging, restart and cursor replay.
   * Only a final echo is suppressed; explicit repeated sends and replies in a new turn remain valid.
   */
  private async isQueuedFinalEcho(conversationId: string, laneKey: string, text: string, beforePage: number, earlier: readonly AgentEvent[]): Promise<boolean> {
    let events = earlier;
    let end = beforePage;
    for (;;) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if ((event.kind === 'MessageEvent' && event.source === 'user') || terminalResponseExtractor(event) !== null) return false;
        if (sendMessageExtractor(event) === null) continue;
        const queued = this.store.getWorkBySourceKey('delivery', `${event.id}:${laneKey}`);
        if (queued && queued.state !== 'skipped' && deliveryText(queued.payload) === text) return true;
      }
      if (end === 0) return false;
      const start = Math.max(0, end - this.outboxSyncPageSize);
      events = (await this.agent.searchEvents(conversationId, String(start), end - start)).items;
      end = start;
    }
  }

  /** Expose the store for worker/claim/settle/reconcile access and audit reads. */
  get workStore(): MessageWorkStore {
    return this.store;
  }
}
