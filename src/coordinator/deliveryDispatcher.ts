/**
 * Durable delivery worker for Message Work Coordinator outbox rows.
 *
 * The dispatcher owns the side-effect boundary: claim -> validate -> mark send-attempted -> platform
 * send -> fenced settlement. It deliberately knows nothing about Slack/Discord/etc.; platform behavior
 * lives behind DeliveryTarget.
 */
import type { MessageWorkStore } from './store.js';
import type { LaneRow } from './types.js';

export interface DeliverySendResult {
  externalMessageId?: string | null;
}

export interface DeliveryTarget {
  /**
   * Optional transport readiness. When it returns false the dispatcher releases the claim untouched (back
   * to `ready`, no attempt counted, no backoff), so a disconnected socket never turns a send that never
   * started into `delivery_unknown` and never burns retries.
   */
  isReady?(): boolean;
  /** Pure/preflight validation. Must not perform external I/O. */
  validate(lane: LaneRow, payload: unknown): void;
  /** Perform the external side effect. Throwing after this starts is treated as ambiguous delivery. */
  deliver(lane: LaneRow, payload: unknown): Promise<DeliverySendResult>;
}

export class DeliveryTargetRegistry {
  private readonly targets = new Map<string, DeliveryTarget>();

  register(platform: string, target: DeliveryTarget): void {
    this.targets.set(platform, target);
  }

  get(platform: string): DeliveryTarget | undefined {
    return this.targets.get(platform);
  }
}

export type DeliveryDispatchOutcome =
  | { kind: 'idle' }
  | { kind: 'delivered'; workId: string; externalMessageId: string | null }
  | { kind: 'failed'; workId: string; error: string }
  | { kind: 'delivery_unknown'; workId: string; error: string }
  | { kind: 'stale'; workId: string }
  /** The platform transport is not connected; the claim was released to `ready` without any send attempt. */
  | { kind: 'transport_unavailable'; workId: string };

export interface DeliveryDispatcherOptions {
  now?: () => number;
  sendTimeoutMs?: number;
}

export class DeliveryDispatcher {
  private readonly sendTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: MessageWorkStore,
    private readonly targets: DeliveryTargetRegistry,
    options: DeliveryDispatcherOptions = {},
  ) {
    this.sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  async dispatchNext(worker: string): Promise<DeliveryDispatchOutcome> {
    const claim = this.store.claimReady(worker, this.now(), 'delivery');
    if (claim === null) return { kind: 'idle' };

    const lane = this.store.getLane(claim.row.laneKey);
    if (lane === null) {
      const error = `delivery lane not found: ${claim.row.laneKey}`;
      this.store.settle(claim, { kind: 'fail', error }, this.now());
      return { kind: 'failed', workId: claim.row.id, error };
    }

    const target = this.targets.get(lane.platform);
    if (target === undefined) {
      const error = `delivery target not registered: ${lane.platform}`;
      this.store.settle(claim, { kind: 'fail', error }, this.now());
      return { kind: 'failed', workId: claim.row.id, error };
    }

    // Validation is deliberately before markSending: malformed work is a known failure, not an
    // ambiguous external effect.
    try {
      target.validate(lane, claim.row.payload);
    } catch (error) {
      const message = errorMessage(error);
      this.store.settle(claim, { kind: 'fail', error: message }, this.now());
      return { kind: 'failed', workId: claim.row.id, error: message };
    }

    // Transport readiness is checked after validation and before markSending: a send that never started
    // is not an attempt at all, never an ambiguous external effect.
    if (target.isReady !== undefined && !target.isReady()) {
      this.store.release(claim, this.now());
      return { kind: 'transport_unavailable', workId: claim.row.id };
    }

    if (!this.store.markSending(claim, this.now())) {
      return { kind: 'stale', workId: claim.row.id };
    }

    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([target.deliver(lane, claim.row.payload), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Platform delivery timed out; outcome unknown')), this.sendTimeoutMs);
      })]).finally(() => { if (timer) clearTimeout(timer); });
      const externalMessageId = result.externalMessageId ?? null;
      const settled = this.store.settle(
        claim,
        { kind: 'done', externalMessageId },
        this.now(),
      );
      return settled === null
        ? { kind: 'stale', workId: claim.row.id }
        : { kind: 'delivered', workId: claim.row.id, externalMessageId };
    } catch (error) {
      // Once markSending is durable we refuse to guess whether the platform accepted the effect. A
      // platform-specific reconciliation path can later confirm/requeue the row explicitly.
      const message = errorMessage(error);
      this.store.settle(
        claim,
        { kind: 'delivery_unknown', error: message },
        this.now(),
      );
      return { kind: 'delivery_unknown', workId: claim.row.id, error: message };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
