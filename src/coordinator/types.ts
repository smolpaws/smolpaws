/**
 * Message Work Coordinator — core types.
 *
 * Grounded in the ADR "Durable message work belongs around agent-server" (§4 canonical record,
 * Fig 2 state machines). See ./DESIGN.md.
 *
 * All timestamps are ISO-8601 UTC strings (`new Date().toISOString()`), which are lexicographically
 * ordered so `available_at <= now` string comparisons are valid.
 */

export type WorkKind = 'intake' | 'delivery';

/**
 * Work lifecycle states (ADR Fig 2). `delivery_unknown` is delivery-only.
 * Terminal-resolved states are `done` and `failed`; everything else blocks the lane head.
 */
export type WorkState =
  | 'ready'
  | 'claimed'
  | 'done'
  | 'retry_wait'
  | 'failed'
  | 'delivery_unknown'
  | 'skipped';

/**
 * States that no longer block later work in the same lane/kind. Per the ADR crash matrix, `failed` and
 * `delivery_unknown` keep blocking the lane ("no silent overtaking") until an operator explicitly skips
 * or repairs them — so only `done` and `skipped` resolve a lane.
 */
export const RESOLVED_STATES: readonly WorkState[] = ['done', 'skipped'];

/** A row in the `lanes` directory (ADR §4). */
export interface LaneRow {
  laneKey: string;
  conversationId: string;
  platform: string;
  accountId: string | null;
  chatId: string;
  threadId: string | null;
  displayName: string | null;
  /** Has agent-server confirmed the conversation exists? (crash-matrix: mapping before creation). */
  conversationReady: boolean;
  createdAt: string;
  lastSeenAt: string;
}

/** A row in the unified `work` queue (ADR §4 canonical record). */
export interface WorkRow {
  id: string;
  kind: WorkKind;
  sourceKey: string;
  laneKey: string;
  sequence: number;
  conversationId: string | null;
  agentEventId: string | null;
  state: WorkState;
  availableAt: string;
  claimOwner: string | null;
  claimUntil: string | null;
  generation: number;
  attempts: number;
  /** Delivery: worker durably set this immediately before the network send. */
  sendAttempted: boolean;
  lastError: string | null;
  externalMessageId: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * A claimed unit of work handed to a worker. `generation` is the fence token: `settle`/`markSending`
 * only apply if the row is still `claimed` at this exact generation.
 */
export interface ClaimedWork {
  row: WorkRow;
  owner: string;
  generation: number;
}

/** Lane descriptor produced by a channel adapter's `computeLane(input)` (ADR §4). */
export interface LaneDescriptor {
  laneKey: string;
  platform: string;
  accountId?: string | null;
  chatId: string;
  threadId?: string | null;
  displayName?: string | null;
}

/** Result of `resolveLane`: the durable lane→conversation binding. */
export interface LaneBinding {
  laneKey: string;
  conversationId: string;
  conversationReady: boolean;
  /** True if this call created the binding (won the insert race). */
  created: boolean;
}

/** Input to accept an intake work item. */
export interface IntakeInput {
  /** Stable platform message identity used to build the unique intake source_key. */
  sourceKey: string;
  /** Deterministic agent-server event id (e.g. uuidv5(platform + message id)). */
  agentEventId: string;
  /** Normalized, serializable payload (no credentials, no live objects). */
  payload: unknown;
}

/** Input to insert a delivery work item (produced by the projector). */
export interface DeliveryInput {
  /** Unique `{agentEventId}:{destinationLaneKey}` key (ADR §8 projection rule). */
  sourceKey: string;
  laneKey: string;
  conversationId: string;
  /** The originating agent event this delivery is derived from. */
  agentEventId: string;
  payload: unknown;
}

/** Outcome the worker reports to `settle`. */
export type SettleOutcome =
  | { kind: 'done'; externalMessageId?: string | null }
  | { kind: 'retry'; error?: string }
  | { kind: 'delivery_unknown'; error?: string }
  | { kind: 'fail'; error?: string };

/** Report from a `reconcile` sweep. */
export interface ReconcileReport {
  expiredToReady: number;
  expiredToDeliveryUnknown: number;
  retryWaitToReady: number;
}

/** Retry / claim policy (injected; deterministic — no jitter by default). */
export interface RetryPolicy {
  maxAttempts: number;
  baseBackoffMs: number;
  capBackoffMs: number;
  claimTtlMs: number;
  /** Optional jitter in ms for production; omit/return 0 in tests. */
  jitterMs?: (attempts: number) => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  baseBackoffMs: 1_000,
  capBackoffMs: 5 * 60_000,
  claimTtlMs: 60_000,
};

/**
 * The narrow agent-server surface the coordinator depends on. Faked in store tests; backed by the real
 * REST client (turnClient-style) in production. Kept upstream-shaped: append + run + event search.
 */
export interface AgentServerClient {
  /** Ensure a conversation with this id exists (idempotent). */
  ensureConversation(conversationId: string): Promise<void>;
  /**
   * Append an event with a caller-supplied deterministic id and optionally request a run.
   * Requires the ADR §8 idempotent-append delta. Returns whether the event was newly created.
   */
  appendEvent(
    conversationId: string,
    event: { eventId: string; role: string; content: unknown; run: boolean },
  ): Promise<{ eventId: string; created: boolean }>;
  /** Page durable events for the projector to catch up from a cursor. */
  searchEvents(
    conversationId: string,
    pageId: string | null,
    limit: number,
  ): Promise<{ items: AgentEvent[]; nextPageId: string | null }>;
}

/** Minimal shape of a durable agent-server event the projector reads. */
export interface AgentEvent {
  id: string;
  kind: string;
  source?: string;
  [key: string]: unknown;
}

/**
 * A projected outbound intent extracted from one durable agent event. The destination lane is derived
 * from the conversation binding, not carried here.
 */
export interface DeliveryIntent {
  payload: unknown;
}

/**
 * Maps one durable agent event to a delivery intent, or null if the event is not deliverable. Keeps the
 * "what is deliverable" policy (ADR D1: explicit send_message actions vs terminal responses) behind the
 * projector interface so it can evolve without touching the store.
 */
export type DeliverableExtractor = (event: AgentEvent) => DeliveryIntent | null;

/** Input to `acceptInbound` — a normalized inbound platform message. */
export interface InboundMessage {
  /** Stable platform message id (drives dedup + deterministic event id). */
  sourceMessageId: string;
  /** LLM message content (string or content array) for the appended user event. */
  content: unknown;
}

/** Outcome of one intake-integration worker step. */
export type IntegrationOutcome =
  | { kind: 'idle' }
  | { kind: 'integrated'; workId: string; eventCreated: boolean }
  | { kind: 'retry'; workId: string; error: string }
  | { kind: 'failed'; workId: string; error: string };
