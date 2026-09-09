/**
 * Deterministic SQLite tests for the Message Work Coordinator store (ADR §9 step 1).
 *
 * Covers: concurrent lane resolution, persisted lane lookup, duplicate accept, per-lane head-of-line
 * order, fenced claim / compare-and-set, claim expiry, backoff, delivery_unknown, and operator repair.
 * Uses real better-sqlite3 files and an injected millisecond clock — no mocks of the unit under test.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MessageWorkStore } from './store.js';
import type { ClaimedWork, LaneDescriptor, RetryPolicy } from './types.js';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed base epoch ms
const at = (offsetMs: number): number => T0 + offsetMs;

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 1_000,
  capBackoffMs: 8_000,
  claimTtlMs: 1_000,
};

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mwc-'));
  return path.join(dir, 'coordinator.db');
}

function newStore(dbPath = tempDbPath()): { store: MessageWorkStore; db: Database.Database; dbPath: string } {
  const db = new Database(dbPath);
  const store = new MessageWorkStore(db, POLICY);
  return { store, db, dbPath };
}

function lane(overrides: Partial<LaneDescriptor> = {}): LaneDescriptor {
  return {
    laneKey: 'channel:whatsapp:acct:chat-7:root',
    platform: 'whatsapp',
    accountId: 'acct',
    chatId: 'chat-7',
    threadId: null,
    ...overrides,
  };
}

function bind(store: MessageWorkStore, now: number, descriptor = lane()) {
  return store.resolveLane(descriptor, `conv-${descriptor.laneKey}`, now);
}

interface LegacyLaneSeed {
  laneKey: string;
  conversationId: string;
}

interface LegacyWorkSeed {
  id: string;
  laneKey: string;
  conversationId: string | null;
}

/** Exact work/lanes shape from before lane ownership was enforced at the SQLite boundary. */
function seedLegacyDatabase(
  dbPath: string,
  seed: { lanes?: LegacyLaneSeed[]; work?: LegacyWorkSeed[] },
): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE lanes (
      lane_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, platform TEXT NOT NULL,
      account_id TEXT, chat_id TEXT NOT NULL, thread_id TEXT, display_name TEXT,
      conversation_ready INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE work (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, source_key TEXT NOT NULL, lane_key TEXT NOT NULL,
      sequence INTEGER NOT NULL, conversation_id TEXT, agent_event_id TEXT, state TEXT NOT NULL,
      available_at TEXT NOT NULL, claim_owner TEXT, claim_until TEXT,
      generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      send_attempted INTEGER NOT NULL DEFAULT 0, last_error TEXT, external_message_id TEXT,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX ux_work_kind_source ON work (kind, source_key);
    CREATE UNIQUE INDEX ux_work_lane_seq ON work (lane_key, kind, sequence);
    CREATE INDEX ix_work_claim ON work (state, available_at);
    CREATE INDEX ix_work_lane ON work (lane_key, kind, sequence);
    CREATE TABLE projection_cursors (
      conversation_id TEXT PRIMARY KEY, next_page_id TEXT, updated_at TEXT NOT NULL, parked_at TEXT
    );
  `);
  const timestamp = new Date(T0).toISOString();
  const insertLane = db.prepare(`
    INSERT INTO lanes (
      lane_key, conversation_id, platform, account_id, chat_id, thread_id, display_name,
      conversation_ready, created_at, last_seen_at
    ) VALUES (?, ?, 'slack', 'acct', ?, NULL, NULL, 1, ?, ?)
  `);
  for (const item of seed.lanes ?? []) {
    insertLane.run(item.laneKey, item.conversationId, item.laneKey, timestamp, timestamp);
  }
  const insertWork = db.prepare(`
    INSERT INTO work (
      id, kind, source_key, lane_key, sequence, conversation_id, agent_event_id, state,
      available_at, payload_json, created_at, updated_at
    ) VALUES (?, 'intake', ?, ?, 1, ?, 'legacy-event', 'ready', ?, ?, ?, ?)
  `);
  for (const item of seed.work ?? []) {
    insertWork.run(
      item.id,
      `source:${item.id}`,
      item.laneKey,
      item.conversationId,
      timestamp,
      JSON.stringify({ text: 'legacy payload' }),
      timestamp,
      timestamp,
    );
  }
  db.close();
}

// ---- Lane directory --------------------------------------------------------------------------------

test('resolveLane creates a binding then returns the same conversation on repeat', () => {
  const { store } = newStore();
  const first = bind(store, at(0));
  assert.equal(first.created, true);
  assert.equal(first.conversationReady, false);

  const second = store.resolveLane(lane(), 'a-different-candidate', at(10));
  assert.equal(second.created, false);
  assert.equal(second.conversationId, first.conversationId); // candidate ignored; existing binding wins
});

test('two first messages resolving one new lane converge on one conversation_id', () => {
  const { store } = newStore();
  const a = store.resolveLane(lane(), 'candidate-A', at(0));
  const b = store.resolveLane(lane(), 'candidate-B', at(1));
  assert.equal(a.conversationId, b.conversationId);
  assert.equal([a.created, b.created].filter(Boolean).length, 1); // exactly one insert won
});

test('one conversation cannot be bound to two lanes', () => {
  const { store } = newStore();
  store.resolveLane(lane({ laneKey: 'lane-a' }), 'shared-conversation', at(0));
  assert.throws(
    () => store.resolveLane(lane({ laneKey: 'lane-b', chatId: 'chat-b' }), 'shared-conversation', at(1)),
    /UNIQUE constraint failed: lanes\.conversation_id/u,
  );
});

test('work must be inserted through a known lane', () => {
  const { store } = newStore();
  assert.throws(
    () => store.acceptIntake('missing-lane', { sourceKey: 'orphan', agentEventId: 'event', payload: {} }, at(0)),
    /unknown lane/u,
  );
  const binding = bind(store, at(1));
  const work = store.insertDelivery({
    sourceKey: 'event:destination',
    laneKey: binding.laneKey,
    agentEventId: 'event',
    payload: {},
  }, at(2));
  assert.equal(work.laneKey, binding.laneKey);
});

test('work schema enforces the lane foreign key after restart', () => {
  const dbPath = tempDbPath();
  const first = newStore(dbPath);
  bind(first.store, at(0));
  first.db.close();
  const second = newStore(dbPath);
  const keys = second.db.prepare('PRAGMA foreign_key_list(work)').all() as Array<{ table: string; from: string }>;
  assert.ok(keys.some((key) => key.table === 'lanes' && key.from === 'lane_key'));
});

test('opening a pre-change database migrates existing work to a single lane-owned conversation binding', () => {
  const dbPath = tempDbPath();
  seedLegacyDatabase(dbPath, {
    lanes: [{ laneKey: 'legacy-lane', conversationId: 'legacy-conversation' }],
    work: [{ id: 'legacy-work', laneKey: 'legacy-lane', conversationId: 'legacy-conversation' }],
  });

  const { store, db } = newStore(dbPath);
  assert.deepEqual(store.getWork('legacy-work')?.payload, { text: 'legacy payload' });
  assert.equal(store.getWork('legacy-work')?.laneKey, 'legacy-lane');
  const columns = db.prepare('PRAGMA table_info(work)').all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'conversation_id'), false);
  const keys = db.prepare('PRAGMA foreign_key_list(work)').all() as Array<{ table: string; from: string }>;
  assert.ok(keys.some((key) => key.table === 'lanes' && key.from === 'lane_key'));
  db.close();
});

test('legacy migration rejects a conversation bound to duplicate lanes', () => {
  const dbPath = tempDbPath();
  seedLegacyDatabase(dbPath, {
    lanes: [
      { laneKey: 'lane-a', conversationId: 'shared-conversation' },
      { laneKey: 'lane-b', conversationId: 'shared-conversation' },
    ],
  });
  const db = new Database(dbPath);
  assert.throws(
    () => new MessageWorkStore(db, POLICY),
    /conversation 'shared-conversation' is bound to 2 lanes/u,
  );
  db.close();
});

test('legacy migration rejects work whose lane is missing', () => {
  const dbPath = tempDbPath();
  seedLegacyDatabase(dbPath, {
    work: [{ id: 'orphan-work', laneKey: 'missing-lane', conversationId: 'legacy-conversation' }],
  });
  const db = new Database(dbPath);
  assert.throws(
    () => new MessageWorkStore(db, POLICY),
    /work 'orphan-work' references unknown lane 'missing-lane'/u,
  );
  db.close();
});

test('legacy migration rejects work whose conversation disagrees with its lane', () => {
  const dbPath = tempDbPath();
  seedLegacyDatabase(dbPath, {
    lanes: [{ laneKey: 'lane-a', conversationId: 'conversation-a' }],
    work: [{ id: 'mismatched-work', laneKey: 'lane-a', conversationId: 'conversation-b' }],
  });
  const db = new Database(dbPath);
  assert.throws(
    () => new MessageWorkStore(db, POLICY),
    /work 'mismatched-work' disagrees with its lane conversation binding/u,
  );
  db.close();
});

test('direct SQLite writes cannot add a conflicting work conversation binding', () => {
  const { store, db } = newStore();
  const binding = bind(store, at(0));
  assert.throws(
    () => db.prepare(`
      INSERT INTO work (
        id, kind, source_key, lane_key, sequence, conversation_id, agent_event_id, state,
        available_at, payload_json, created_at, updated_at
      ) VALUES (
        'mismatch', 'intake', 'mismatch', '${binding.laneKey}', 1, 'wrong-conversation',
        'event', 'ready', '2026-01-01T00:00:00.000Z', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `).run(),
    /no column named conversation_id/u,
  );
});

test('direct SQLite writes cannot insert work for an unknown lane', () => {
  const { db } = newStore();
  assert.throws(
    () => db.prepare(`
      INSERT INTO work (
        id, kind, source_key, lane_key, sequence, agent_event_id, state,
        available_at, payload_json, created_at, updated_at
      ) VALUES (
        'orphan', 'intake', 'orphan', 'missing-lane', 1, 'event', 'ready',
        '2026-01-01T00:00:00.000Z', '{}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      )
    `).run(),
    /FOREIGN KEY constraint failed/u,
  );
});

test('markLaneConversationReady flips the durable flag', () => {
  const { store } = newStore();
  bind(store, at(0));
  assert.equal(store.getLane(lane().laneKey)?.conversationReady, false);
  store.markLaneConversationReady(lane().laneKey, at(5));
  assert.equal(store.getLane(lane().laneKey)?.conversationReady, true);
});

// ---- Accept / idempotency --------------------------------------------------------------------------

test('acceptIntake is idempotent on source_key and assigns monotonic per-lane sequence', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const a1 = store.acceptIntake(binding.laneKey, { sourceKey: 'wa:msg-A', agentEventId: 'ev-A', payload: { t: 'A' } }, at(1));
  const a2 = store.acceptIntake(binding.laneKey, { sourceKey: 'wa:msg-A', agentEventId: 'ev-A', payload: { t: 'A' } }, at(2));
  assert.equal(a1.id, a2.id); // duplicate accept returns the existing row
  assert.equal(a1.sequence, 1);

  const b = store.acceptIntake(binding.laneKey, { sourceKey: 'wa:msg-B', agentEventId: 'ev-B', payload: { t: 'B' } }, at(3));
  assert.equal(b.sequence, 2);
});

test('intake and delivery keep independent sequences within a lane', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const i1 = store.acceptIntake(binding.laneKey, { sourceKey: 'i1', agentEventId: 'e1', payload: {} }, at(1));
  const d1 = store.insertDelivery(
    { sourceKey: 'e1:dest', laneKey: binding.laneKey, agentEventId: 'e1', payload: {} },
    at(2),
  );
  assert.equal(i1.sequence, 1);
  assert.equal(d1.sequence, 1); // delivery numbering is independent of intake
});

// ---- Per-lane head-of-line ordering ----------------------------------------------------------------

test('only the unresolved lane head is claimable; later work waits behind it', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const a = store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(1));
  store.acceptIntake(binding.laneKey, { sourceKey: 'B', agentEventId: 'eB', payload: {} }, at(2));

  const claim = store.claimReady('w1', at(3), 'intake');
  assert.equal(claim?.row.id, a.id); // head first

  // B must not be claimable while A is still in flight (claimed).
  assert.equal(store.claimReady('w2', at(4), 'intake'), null);

  // Resolve A → B becomes the head.
  store.settle(claim!, { kind: 'done' }, at(5));
  const next = store.claimReady('w2', at(6), 'intake');
  assert.equal(next?.row.sequence, 2);
});

// ---- Fenced claim / compare-and-set ----------------------------------------------------------------

test('a row cannot be double-claimed and a stale generation cannot settle', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(1));

  const claim = store.claimReady('w1', at(2), 'intake');
  assert.ok(claim);
  // Second worker gets nothing (row is claimed, and it is the only lane head).
  assert.equal(store.claimReady('w2', at(2), 'intake'), null);

  // Simulate a stale worker holding the pre-claim generation.
  const staleClaim: ClaimedWork = { ...claim!, generation: claim!.generation - 1 };
  assert.equal(store.settle(staleClaim, { kind: 'done' }, at(3)), null); // fenced out
  assert.equal(store.getWork(claim!.row.id)?.state, 'claimed'); // unchanged

  assert.equal(store.settle(claim!, { kind: 'done' }, at(4)), 'done'); // correct fence wins
});

test('claimReady across two connections on the same file yields one winner', () => {
  const dbPath = tempDbPath();
  const a = newStore(dbPath);
  const b = newStore(dbPath);
  const binding = bind(a.store, at(0));
  a.store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(1));

  const claimA = a.store.claimReady('A', at(2), 'intake');
  const claimB = b.store.claimReady('B', at(2), 'intake');
  assert.equal([claimA, claimB].filter(Boolean).length, 1);
});

// ---- Claim expiry / reconcile ----------------------------------------------------------------------

test('an expired intake claim reconciles back to ready and is reclaimable', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(1));
  const claim = store.claimReady('w1', at(2), 'intake');
  assert.ok(claim);

  // Before expiry: nothing to reconcile.
  assert.deepEqual(store.reconcile(at(2 + 500)), { expiredToReady: 0, expiredToDeliveryUnknown: 0, retryWaitToReady: 0 });

  // After claim_until (claim at t=2ms, ttl=1000ms → expires at 1002ms).
  const report = store.reconcile(at(2 + 1_001));
  assert.equal(report.expiredToReady, 1);
  assert.equal(store.getWork(claim!.row.id)?.state, 'ready');

  // The old claim is now fenced (generation bumped by reconcile).
  assert.equal(store.settle(claim!, { kind: 'done' }, at(2000)), null);

  const reclaim = store.claimReady('w2', at(2100), 'intake');
  assert.equal(reclaim?.row.id, claim!.row.id);
});

test('delivery claim that attempted a send reconciles to delivery_unknown, not ready', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const d = store.insertDelivery(
    { sourceKey: 'e1:dest', laneKey: binding.laneKey, agentEventId: 'e1', payload: {} },
    at(1),
  );
  const claim = store.claimReady('w1', at(2), 'delivery');
  assert.ok(claim);
  assert.equal(store.markSending(claim!, at(3)), true); // durable pre-send marker

  const report = store.reconcile(at(2 + 1_001));
  assert.equal(report.expiredToDeliveryUnknown, 1);
  assert.equal(report.expiredToReady, 0);
  assert.equal(store.getWork(d.id)?.state, 'delivery_unknown');

  // delivery_unknown is NEVER auto-retried and blocks the lane.
  assert.equal(store.claimReady('w2', at(5000), 'delivery'), null);
});

test('delivery claim that crashed before sending reconciles to ready', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  store.insertDelivery(
    { sourceKey: 'e1:dest', laneKey: binding.laneKey, agentEventId: 'e1', payload: {} },
    at(1),
  );
  const claim = store.claimReady('w1', at(2), 'delivery');
  assert.ok(claim);
  // No markSending → crash before send is safe to retry.
  const report = store.reconcile(at(2 + 1_001));
  assert.equal(report.expiredToReady, 1);
  assert.equal(report.expiredToDeliveryUnknown, 0);
});

// ---- Backoff / retry / failure ---------------------------------------------------------------------

test('settle(retry) schedules exponential backoff and exhausts to failed', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const work = store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(0));

  // attempt 1
  let claim = store.claimReady('w', at(0), 'intake');
  assert.equal(claim?.row.attempts, 1);
  assert.equal(store.settle(claim!, { kind: 'retry', error: 'boom' }, at(0)), 'retry_wait');
  // backoff after attempt 1 = base * 2^0 = 1000ms → available_at = 1000ms
  assert.equal(store.getWork(work.id)?.availableAt, new Date(at(1_000)).toISOString());

  // Not claimable before backoff; promoted to ready by reconcile at/after available_at.
  assert.equal(store.claimReady('w', at(500), 'intake'), null);
  store.reconcile(at(1_000));
  assert.equal(store.getWork(work.id)?.state, 'ready');

  // attempt 2 → backoff = base * 2^1 = 2000ms
  claim = store.claimReady('w', at(1_000), 'intake');
  assert.equal(claim?.row.attempts, 2);
  store.settle(claim!, { kind: 'retry' }, at(1_000));
  assert.equal(store.getWork(work.id)?.availableAt, new Date(at(1_000 + 2_000)).toISOString());
  store.reconcile(at(3_000));

  // attempt 3 → attempts == maxAttempts(3) → next retry fails
  claim = store.claimReady('w', at(3_000), 'intake');
  assert.equal(claim?.row.attempts, 3);
  assert.equal(store.settle(claim!, { kind: 'retry', error: 'still bad' }, at(3_000)), 'failed');
  assert.equal(store.getWork(work.id)?.lastError, 'still bad');
});

// ---- delivery_unknown / operator repair ------------------------------------------------------------

test('settle(done) records the external message id', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  store.insertDelivery(
    { sourceKey: 'e1:dest', laneKey: binding.laneKey, agentEventId: 'e1', payload: {} },
    at(1),
  );
  const claim = store.claimReady('w', at(2), 'delivery');
  store.markSending(claim!, at(3));
  assert.equal(store.settle(claim!, { kind: 'done', externalMessageId: 'slack-ts-123' }, at(4)), 'done');
  assert.equal(store.getWork(claim!.row.id)?.externalMessageId, 'slack-ts-123');
});

test('a failed head blocks the lane until an operator skips it', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const a = store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(0));
  store.acceptIntake(binding.laneKey, { sourceKey: 'B', agentEventId: 'eB', payload: {} }, at(0));

  const claim = store.claimReady('w', at(0), 'intake');
  store.settle(claim!, { kind: 'fail', error: 'poison' }, at(0)); // A → failed

  // B stays blocked behind the failed head (no silent overtaking).
  assert.equal(store.claimReady('w', at(1), 'intake'), null);

  assert.equal(store.skip(a.id, at(2)), 'skipped');
  const next = store.claimReady('w', at(3), 'intake');
  assert.equal(next?.row.sequence, 2); // B now claimable
});

test('confirmDelivered and requeue resolve a delivery_unknown item', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  const d = store.insertDelivery(
    { sourceKey: 'e1:dest', laneKey: binding.laneKey, agentEventId: 'e1', payload: {} },
    at(1),
  );
  const claim = store.claimReady('w', at(2), 'delivery');
  store.markSending(claim!, at(3));
  store.settle(claim!, { kind: 'delivery_unknown', error: 'timeout' }, at(4));
  assert.equal(store.getWork(d.id)?.state, 'delivery_unknown');

  // Operator confirms it actually landed.
  assert.equal(store.confirmDelivered(d.id, 'msg-99', at(5)), 'done');
  assert.equal(store.getWork(d.id)?.externalMessageId, 'msg-99');

  // requeue only applies to failed/delivery_unknown; a done row is untouched.
  assert.equal(store.requeue(d.id, at(6)), null);
});

test('claimReady kind filter isolates intake from delivery', () => {
  const { store } = newStore();
  const binding = bind(store, at(0));
  store.acceptIntake(binding.laneKey, { sourceKey: 'A', agentEventId: 'eA', payload: {} }, at(0));
  store.insertDelivery(
    { sourceKey: 'eA:dest', laneKey: binding.laneKey, agentEventId: 'eA', payload: {} },
    at(0),
  );
  assert.equal(store.claimReady('w', at(1), 'delivery')?.row.kind, 'delivery');
  assert.equal(store.claimReady('w', at(1), 'intake')?.row.kind, 'intake');
});

// cleanup best-effort: temp dirs are unique per test; remove on process exit is unnecessary for CI.
void randomUUID;
void rmSync;
