/**
 * Message Work Coordinator — durable SQLite store (ADR §3–§5, Fig 2).
 *
 * This is the source of truth for external work: the lane directory and the unified intake/delivery
 * queue with fenced compare-and-set claims, backoff, claim expiry, per-lane head-of-line ordering, and
 * `delivery_unknown` handling. It is deliberately clock-injected (every mutating method takes `now`) so
 * the state machines are fully deterministic under test with real SQLite.
 *
 * The store does no network I/O; agent-server interaction lives in the coordinator layer.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { applySchema } from './schema.js';
import {
  DEFAULT_RETRY_POLICY,
  RESOLVED_STATES,
  type ClaimedWork,
  type DeliveryInput,
  type IntakeInput,
  type LaneBinding,
  type LaneDescriptor,
  type LaneRow,
  type ReconcileReport,
  type RetryPolicy,
  type SettleOutcome,
  type WorkKind,
  type WorkRow,
  type WorkState,
} from './types.js';

const RESOLVED_LIST = RESOLVED_STATES.map((s) => `'${s}'`).join(', ');

interface RawWorkRow {
  id: string;
  kind: string;
  source_key: string;
  lane_key: string;
  sequence: number;
  conversation_id: string | null;
  agent_event_id: string | null;
  state: string;
  available_at: string;
  claim_owner: string | null;
  claim_until: string | null;
  generation: number;
  attempts: number;
  send_attempted: number;
  last_error: string | null;
  external_message_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface RawLaneRow {
  lane_key: string;
  conversation_id: string;
  platform: string;
  account_id: string | null;
  chat_id: string;
  thread_id: string | null;
  display_name: string | null;
  conversation_ready: number;
  created_at: string;
  last_seen_at: string;
}

function iso(now: Date | number): string {
  return (typeof now === 'number' ? new Date(now) : now).toISOString();
}

function mapWork(raw: RawWorkRow): WorkRow {
  return {
    id: raw.id,
    kind: raw.kind as WorkKind,
    sourceKey: raw.source_key,
    laneKey: raw.lane_key,
    sequence: raw.sequence,
    conversationId: raw.conversation_id,
    agentEventId: raw.agent_event_id,
    state: raw.state as WorkState,
    availableAt: raw.available_at,
    claimOwner: raw.claim_owner,
    claimUntil: raw.claim_until,
    generation: raw.generation,
    attempts: raw.attempts,
    sendAttempted: raw.send_attempted !== 0,
    lastError: raw.last_error,
    externalMessageId: raw.external_message_id,
    payload: JSON.parse(raw.payload_json) as unknown,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function mapLane(raw: RawLaneRow): LaneRow {
  return {
    laneKey: raw.lane_key,
    conversationId: raw.conversation_id,
    platform: raw.platform,
    accountId: raw.account_id,
    chatId: raw.chat_id,
    threadId: raw.thread_id,
    displayName: raw.display_name,
    conversationReady: raw.conversation_ready !== 0,
    createdAt: raw.created_at,
    lastSeenAt: raw.last_seen_at,
  };
}

export class MessageWorkStore {
  private readonly db: Database.Database;
  private readonly policy: RetryPolicy;

  constructor(db: Database.Database, policy: RetryPolicy = DEFAULT_RETRY_POLICY) {
    this.db = db;
    this.policy = policy;
    applySchema(db);
  }

  // ---- Lane directory (ADR §4) -------------------------------------------------------------------

  /**
   * Find-or-create the lane→conversation binding. Idempotent and race-safe: `INSERT ... ON CONFLICT DO
   * NOTHING` then read back, so two first messages that resolve one new lane converge on a single
   * `conversation_id` (crash matrix). `last_seen_at` is refreshed on every resolve.
   */
  resolveLane(
    descriptor: LaneDescriptor,
    candidateConversationId: string,
    now: Date | number,
  ): LaneBinding {
    const ts = iso(now);
    const tx = this.db.transaction((): LaneBinding => {
      const insert = this.db
        .prepare(
          `INSERT INTO lanes (lane_key, conversation_id, platform, account_id, chat_id, thread_id,
             display_name, conversation_ready, created_at, last_seen_at)
           VALUES (@lane_key, @conversation_id, @platform, @account_id, @chat_id, @thread_id,
             @display_name, 0, @created_at, @last_seen_at)
           ON CONFLICT(lane_key) DO NOTHING`,
        )
        .run({
          lane_key: descriptor.laneKey,
          conversation_id: candidateConversationId,
          platform: descriptor.platform,
          account_id: descriptor.accountId ?? null,
          chat_id: descriptor.chatId,
          thread_id: descriptor.threadId ?? null,
          display_name: descriptor.displayName ?? null,
          created_at: ts,
          last_seen_at: ts,
        });
      const created = insert.changes === 1;
      if (!created) {
        this.db
          .prepare(`UPDATE lanes SET last_seen_at = ? WHERE lane_key = ?`)
          .run(ts, descriptor.laneKey);
      }
      const row = this.db
        .prepare(`SELECT * FROM lanes WHERE lane_key = ?`)
        .get(descriptor.laneKey) as RawLaneRow;
      const lane = mapLane(row);
      return {
        laneKey: lane.laneKey,
        conversationId: lane.conversationId,
        conversationReady: lane.conversationReady,
        created,
      };
    });
    return tx.immediate();
  }

  /** Mark the lane's conversation as confirmed-to-exist in agent-server (crash-matrix ordering). */
  markLaneConversationReady(laneKey: string, now: Date | number): void {
    this.db
      .prepare(`UPDATE lanes SET conversation_ready = 1, last_seen_at = ? WHERE lane_key = ?`)
      .run(iso(now), laneKey);
  }

  getLane(laneKey: string): LaneRow | null {
    const row = this.db.prepare(`SELECT * FROM lanes WHERE lane_key = ?`).get(laneKey) as
      | RawLaneRow
      | undefined;
    return row ? mapLane(row) : null;
  }

  getLaneByConversationId(conversationId: string): LaneRow | null {
    const row = this.db
      .prepare(`SELECT * FROM lanes WHERE conversation_id = ? LIMIT 1`)
      .get(conversationId) as RawLaneRow | undefined;
    return row ? mapLane(row) : null;
  }

  // ---- Accept work -------------------------------------------------------------------------------

  /** Accept intake work; idempotent on (kind='intake', source_key). Returns existing-or-new row. */
  acceptIntake(binding: LaneBinding, input: IntakeInput, now: Date | number): WorkRow {
    return this.insertWork('intake', {
      sourceKey: input.sourceKey,
      laneKey: binding.laneKey,
      conversationId: binding.conversationId,
      agentEventId: input.agentEventId,
      payload: input.payload,
    }, now);
  }

  /** Insert delivery work (from the projector); idempotent on (kind='delivery', source_key). */
  insertDelivery(input: DeliveryInput, now: Date | number): WorkRow {
    return this.insertWork('delivery', {
      sourceKey: input.sourceKey,
      laneKey: input.laneKey,
      conversationId: input.conversationId,
      agentEventId: input.agentEventId,
      payload: input.payload,
    }, now);
  }

  private insertWork(
    kind: WorkKind,
    fields: {
      sourceKey: string;
      laneKey: string;
      conversationId: string | null;
      agentEventId: string | null;
      payload: unknown;
    },
    now: Date | number,
  ): WorkRow {
    const ts = iso(now);
    const tx = this.db.transaction((): WorkRow => {
      const existing = this.db
        .prepare(`SELECT * FROM work WHERE kind = ? AND source_key = ?`)
        .get(kind, fields.sourceKey) as RawWorkRow | undefined;
      if (existing) {
        return mapWork(existing);
      }
      const seqRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM work WHERE lane_key = ? AND kind = ?`,
        )
        .get(fields.laneKey, kind) as { next: number };
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO work (id, kind, source_key, lane_key, sequence, conversation_id, agent_event_id,
             state, available_at, generation, attempts, send_attempted, payload_json, created_at, updated_at)
           VALUES (@id, @kind, @source_key, @lane_key, @sequence, @conversation_id, @agent_event_id,
             'ready', @available_at, 0, 0, 0, @payload_json, @created_at, @updated_at)`,
        )
        .run({
          id,
          kind,
          source_key: fields.sourceKey,
          lane_key: fields.laneKey,
          sequence: seqRow.next,
          conversation_id: fields.conversationId,
          agent_event_id: fields.agentEventId,
          available_at: ts,
          payload_json: JSON.stringify(fields.payload ?? null),
          created_at: ts,
          updated_at: ts,
        });
      return mapWork(this.db.prepare(`SELECT * FROM work WHERE id = ?`).get(id) as RawWorkRow);
    });
    return tx.immediate();
  }

  // ---- Claim (fenced compare-and-set, lane-head only) --------------------------------------------

  /**
   * Claim the next ready lane-head, optionally restricted to a kind. A row is claimable iff it is
   * `ready`, `available_at <= now`, and it is the head of its (lane_key, kind) — i.e. no earlier-sequence
   * row in the same lane/kind is still unresolved. The claim bumps `generation` (the fence) and
   * `attempts`. Returns null if nothing is claimable.
   */
  claimReady(worker: string, now: Date | number, kind?: WorkKind): ClaimedWork | null {
    const ts = iso(now);
    const claimUntil = iso((typeof now === 'number' ? now : now.getTime()) + this.policy.claimTtlMs);
    const tx = this.db.transaction((): ClaimedWork | null => {
      // A bounded scan: pick candidate heads ordered by readiness, then guard the update.
      const candidates = this.db
        .prepare(
          `SELECT * FROM work r
           WHERE r.state = 'ready'
             AND r.available_at <= @now
             AND (@kind IS NULL OR r.kind = @kind)
             AND NOT EXISTS (
               SELECT 1 FROM work w2
               WHERE w2.lane_key = r.lane_key AND w2.kind = r.kind
                 AND w2.sequence < r.sequence
                 AND w2.state NOT IN (${RESOLVED_LIST})
             )
           ORDER BY r.available_at ASC, r.sequence ASC
           LIMIT 8`,
        )
        .all({ now: ts, kind: kind ?? null }) as RawWorkRow[];
      for (const candidate of candidates) {
        const nextGen = candidate.generation + 1;
        const res = this.db
          .prepare(
            `UPDATE work
             SET state = 'claimed', claim_owner = @owner, claim_until = @claim_until,
                 generation = @next_gen, attempts = attempts + 1, updated_at = @now
             WHERE id = @id AND state = 'ready' AND generation = @gen`,
          )
          .run({
            owner: worker,
            claim_until: claimUntil,
            next_gen: nextGen,
            now: ts,
            id: candidate.id,
            gen: candidate.generation,
          });
        if (res.changes === 1) {
          const row = mapWork(
            this.db.prepare(`SELECT * FROM work WHERE id = ?`).get(candidate.id) as RawWorkRow,
          );
          return { row, owner: worker, generation: nextGen };
        }
      }
      return null;
    });
    return tx.immediate();
  }

  /**
   * Delivery: durably record that a network send is about to be attempted, so a crash between send and
   * settle is reconciled as `delivery_unknown` rather than blindly retried. Fenced by generation.
   * Returns false if the claim is stale (already reclaimed/settled).
   */
  markSending(claim: ClaimedWork, now: Date | number): boolean {
    const res = this.db
      .prepare(
        `UPDATE work SET send_attempted = 1, updated_at = @now
         WHERE id = @id AND state = 'claimed' AND generation = @gen`,
      )
      .run({ now: iso(now), id: claim.row.id, gen: claim.generation });
    return res.changes === 1;
  }

  // ---- Settle (fenced) ---------------------------------------------------------------------------

  /**
   * Settle a claimed item. Guarded by (state='claimed' AND generation=claim.generation) so a stale worker
   * whose claim expired and was reclaimed cannot settle a newer attempt. Returns the resulting state, or
   * null if the claim was stale (no-op).
   */
  settle(claim: ClaimedWork, outcome: SettleOutcome, now: Date | number): WorkState | null {
    const ts = iso(now);
    const nowMs = typeof now === 'number' ? now : now.getTime();
    const tx = this.db.transaction((): WorkState | null => {
      const current = this.db.prepare(`SELECT * FROM work WHERE id = ?`).get(claim.row.id) as
        | RawWorkRow
        | undefined;
      if (!current || current.state !== 'claimed' || current.generation !== claim.generation) {
        return null;
      }
      let next: WorkState;
      const set: Record<string, unknown> = { id: claim.row.id, now: ts };
      switch (outcome.kind) {
        case 'done':
          next = 'done';
          this.db
            .prepare(
              `UPDATE work SET state='done', external_message_id=@ext, claim_owner=NULL,
                 claim_until=NULL, updated_at=@now WHERE id=@id`,
            )
            .run({ ...set, ext: outcome.externalMessageId ?? null });
          break;
        case 'delivery_unknown':
          next = 'delivery_unknown';
          this.db
            .prepare(
              `UPDATE work SET state='delivery_unknown', last_error=@err, claim_owner=NULL,
                 claim_until=NULL, updated_at=@now WHERE id=@id`,
            )
            .run({ ...set, err: outcome.error ?? null });
          break;
        case 'retry': {
          if (current.attempts >= this.policy.maxAttempts) {
            next = 'failed';
            this.db
              .prepare(
                `UPDATE work SET state='failed', last_error=@err, claim_owner=NULL, claim_until=NULL,
                   updated_at=@now WHERE id=@id`,
              )
              .run({ ...set, err: outcome.error ?? 'attempts exhausted' });
          } else {
            next = 'retry_wait';
            const availableAt = iso(nowMs + this.backoffMs(current.attempts));
            this.db
              .prepare(
                `UPDATE work SET state='retry_wait', last_error=@err, available_at=@avail,
                   claim_owner=NULL, claim_until=NULL, updated_at=@now WHERE id=@id`,
              )
              .run({ ...set, err: outcome.error ?? null, avail: availableAt });
          }
          break;
        }
        case 'fail':
          next = 'failed';
          this.db
            .prepare(
              `UPDATE work SET state='failed', last_error=@err, claim_owner=NULL, claim_until=NULL,
                 updated_at=@now WHERE id=@id`,
            )
            .run({ ...set, err: outcome.error ?? null });
          break;
      }
      return next;
    });
    return tx.immediate();
  }

  private backoffMs(attempts: number): number {
    const exp = Math.min(
      this.policy.capBackoffMs,
      this.policy.baseBackoffMs * 2 ** Math.max(0, attempts - 1),
    );
    return exp + (this.policy.jitterMs?.(attempts) ?? 0);
  }

  // ---- Reconcile (crash recovery / self-heal) ----------------------------------------------------

  /**
   * Sweep for recovery (ADR crash matrix + Hermes stale-guard self-heal):
   *  - expired delivery claims that had already attempted a send → `delivery_unknown`;
   *  - other expired claims → `ready` (safe retry);
   *  - `retry_wait` whose backoff has elapsed → `ready`.
   * Expiry bumps `generation` so a returning stale worker cannot settle the old attempt.
   */
  reconcile(now: Date | number): ReconcileReport {
    const ts = iso(now);
    const tx = this.db.transaction((): ReconcileReport => {
      const toUnknown = this.db
        .prepare(
          `UPDATE work SET state='delivery_unknown', generation=generation+1, claim_owner=NULL,
             claim_until=NULL, last_error='claim expired after send attempt', updated_at=@now
           WHERE state='claimed' AND claim_until <= @now AND kind='delivery' AND send_attempted=1`,
        )
        .run({ now: ts });
      const toReady = this.db
        .prepare(
          `UPDATE work SET state='ready', generation=generation+1, claim_owner=NULL, claim_until=NULL,
             updated_at=@now
           WHERE state='claimed' AND claim_until <= @now
             AND NOT (kind='delivery' AND send_attempted=1)`,
        )
        .run({ now: ts });
      const retryReady = this.db
        .prepare(
          `UPDATE work SET state='ready', updated_at=@now
           WHERE state='retry_wait' AND available_at <= @now`,
        )
        .run({ now: ts });
      return {
        expiredToDeliveryUnknown: toUnknown.changes,
        expiredToReady: toReady.changes,
        retryWaitToReady: retryReady.changes,
      };
    });
    return tx.immediate();
  }

  // ---- Operator / repair ops (unblock a lane held by failed / delivery_unknown) -----------------

  /** Explicitly skip a blocking terminal item (`failed`/`delivery_unknown`) → `skipped` (unblocks lane). */
  skip(id: string, now: Date | number): WorkState | null {
    return this.operatorTransition(id, ['failed', 'delivery_unknown'], 'skipped', now);
  }

  /** Confirm an ambiguous delivery actually landed → `done`. */
  confirmDelivered(id: string, externalMessageId: string | null, now: Date | number): WorkState | null {
    const res = this.db
      .prepare(
        `UPDATE work SET state='done', external_message_id=@ext, updated_at=@now
         WHERE id=@id AND state='delivery_unknown'`,
      )
      .run({ id, ext: externalMessageId, now: iso(now) });
    return res.changes === 1 ? 'done' : null;
  }

  /** Operator repair: return a blocking terminal item to `ready` for another attempt. */
  requeue(id: string, now: Date | number): WorkState | null {
    const res = this.db
      .prepare(
        `UPDATE work SET state='ready', available_at=@now, send_attempted=0, claim_owner=NULL,
           claim_until=NULL, generation=generation+1, updated_at=@now
         WHERE id=@id AND state IN ('failed','delivery_unknown')`,
      )
      .run({ id, now: iso(now) });
    return res.changes === 1 ? 'ready' : null;
  }

  private operatorTransition(
    id: string,
    from: WorkState[],
    to: WorkState,
    now: Date | number,
  ): WorkState | null {
    const placeholders = from.map(() => '?').join(', ');
    const res = this.db
      .prepare(
        `UPDATE work SET state=?, updated_at=? WHERE id=? AND state IN (${placeholders})`,
      )
      .run(to, iso(now), id, ...from);
    return res.changes === 1 ? to : null;
  }

  // ---- Reads (audit / tests) ---------------------------------------------------------------------

  getWork(id: string): WorkRow | null {
    const row = this.db.prepare(`SELECT * FROM work WHERE id = ?`).get(id) as RawWorkRow | undefined;
    return row ? mapWork(row) : null;
  }

  getWorkBySourceKey(kind: WorkKind, sourceKey: string): WorkRow | null {
    const row = this.db
      .prepare(`SELECT * FROM work WHERE kind = ? AND source_key = ?`)
      .get(kind, sourceKey) as RawWorkRow | undefined;
    return row ? mapWork(row) : null;
  }

  // ---- Projection cursor -------------------------------------------------------------------------

  getProjectionCursor(conversationId: string): string | null {
    const row = this.db
      .prepare(`SELECT next_page_id FROM projection_cursors WHERE conversation_id = ?`)
      .get(conversationId) as { next_page_id: string | null } | undefined;
    return row ? row.next_page_id : null;
  }

  setProjectionCursor(conversationId: string, nextPageId: string | null, now: Date | number): void {
    this.db
      .prepare(
        `INSERT INTO projection_cursors (conversation_id, next_page_id, updated_at)
         VALUES (@id, @page, @now)
         ON CONFLICT(conversation_id) DO UPDATE SET next_page_id = @page, updated_at = @now`,
      )
      .run({ id: conversationId, page: nextPageId, now: iso(now) });
  }

  listLaneWork(laneKey: string, kind?: WorkKind): WorkRow[] {
    const rows = kind
      ? (this.db
          .prepare(`SELECT * FROM work WHERE lane_key = ? AND kind = ? ORDER BY sequence ASC`)
          .all(laneKey, kind) as RawWorkRow[])
      : (this.db
          .prepare(`SELECT * FROM work WHERE lane_key = ? ORDER BY kind, sequence ASC`)
          .all(laneKey) as RawWorkRow[]);
    return rows.map(mapWork);
  }
}
