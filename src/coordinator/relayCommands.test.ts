import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MessageRelay } from './messageRelay.js';
import { MessageWorkStore } from './store.js';
import { parseRelayCommand } from './relayCommands.js';
import type { AgentServerClient, LaneDescriptor } from './types.js';

const lane: LaneDescriptor = { laneKey: 'slack:T:C', platform: 'slack', accountId: 'T', chatId: 'C' };
function fixture(condense: NonNullable<AgentServerClient['condense']> = async () => {}) {
  const db = new Database(':memory:'); const store = new MessageWorkStore(db);
  const appended: unknown[] = []; let calls = 0; let now = 1_000;
  const agent: AgentServerClient = { async ensureConversation() {},
    async appendEvent(_id, event) { appended.push(event.content); return { eventId: event.eventId, created: true }; },
    async searchEvents() { return { items: [], nextPageId: null }; },
    async condense(id, signal) { calls++; await condense(id, signal); } };
  const relay = new MessageRelay(store, agent, { now: () => now, commandTimeoutMs: 500 });
  return { db, store, relay, agent, appended, calls: () => calls, advance: () => { now += 1_000; } };
}
const command = (id = 'command') => ({ sourceMessageId: id, content: '/condense', command: { kind: 'condense' as const } });
function receipts(db: Database.Database) { return db.prepare("SELECT payload_json FROM work WHERE kind='delivery'").all() as { payload_json: string }[]; }

test('only exact direct normalized command text matches', () => {
  assert.deepEqual(parseRelayCommand('  /condense\n'), { kind: 'condense' });
  for (const text of ['please /condense', '/condense now', '`/condense`', '> /condense', '/condense\nhello', '/Condense', '<messages>/condense</messages>', '/new']) assert.equal(parseRelayCommand(text), undefined);
});

test('one durable command performs one POST, no user turn, and one durable receipt across replay', async () => {
  const f = fixture(); try {
    const row = await f.relay.acceptInbound(lane, command());
    await f.relay.acceptInbound(lane, command());
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'command_started');
    await f.relay.whenCommandsIdle();
    assert.equal(f.calls(), 1); assert.deepEqual(f.appended, []);
    assert.equal(f.store.getCommand(row.id)?.status, 'succeeded');
    assert.equal(receipts(f.db).length, 1);
    await new MessageRelay(f.store, f.agent).acceptInbound(lane, command());
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'idle');
    assert.equal(f.calls(), 1); assert.equal(receipts(f.db).length, 1);
  } finally { f.db.close(); }
});

test('a long command leaves other lanes and outbound projection responsive', async () => {
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
  const f = fixture(async () => pending); try {
    await f.relay.acceptInbound(lane, command());
    await f.relay.acceptInbound(lane, { sourceMessageId: 'next', content: 'later' });
    await f.relay.acceptInbound({ ...lane, laneKey: 'other', chatId: 'other' }, { sourceMessageId: 'other', content: 'other' });
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'command_started');
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'integrated');
    assert.deepEqual(f.appended, ['other']);
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'idle');
    finish(); await f.relay.whenCommandsIdle();
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'integrated');
    assert.deepEqual(f.appended, ['other', 'later']);
  } finally { finish(); await f.relay.whenCommandsIdle(); f.db.close(); }
});

for (const failure of [new Error('response lost secret=private'), Object.assign(new Error('upstream'), { status: 500 })]) {
  test(`uncertain command result is terminal, sanitized, never retried, and permits later intake: ${failure.message}`, async () => {
    const f = fixture(async () => { throw failure; }); try {
      const row = await f.relay.acceptInbound(lane, command());
      await f.relay.integrateNextIntake('worker'); await f.relay.whenCommandsIdle();
      assert.equal(f.store.getCommand(row.id)?.status, 'unknown');
      assert.match(receipts(f.db)[0].payload_json, /unconfirmed/);
      assert.ok(!receipts(f.db)[0].payload_json.includes('private'));
      f.advance(); f.store.reconcile(2_000);
      await f.relay.acceptInbound(lane, { sourceMessageId: 'next', content: 'continue' });
      assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'integrated');
      await f.relay.acceptInbound(lane, command('explicit-new-command'));
      await f.relay.integrateNextIntake('worker'); await f.relay.whenCommandsIdle();
      assert.equal(f.calls(), 2);
    } finally { f.db.close(); }
  });
}

test('restart after durable attempt fence yields one unknown receipt and rejects stale completion', async () => {
  const f = fixture(); try {
    const row = await f.relay.acceptInbound(lane, command());
    const claim = f.store.claimReady('crashed', 1_000, 'intake')!;
    assert.equal(f.store.startCommand(claim, 1_000, 500), true);
    const restored = new MessageWorkStore(f.db);
    restored.reconcile(2_000); restored.reconcile(3_000);
    assert.equal(restored.getCommand(row.id)?.status, 'unknown');
    assert.equal(restored.finishCommand(claim, 'succeeded', 3_000), false);
    assert.equal(receipts(f.db).length, 1); assert.equal(f.calls(), 0);
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'idle');
  } finally { f.db.close(); }
});

test('raw command-looking content and replay metadata cannot promote an ordinary message', async () => {
  const f = fixture(); try {
    await f.relay.acceptInbound(lane, { sourceMessageId: 'text', content: '/condense' });
    await f.relay.acceptInbound(lane, command('text'));
    await f.relay.integrateNextIntake('worker');
    assert.deepEqual(f.appended, ['/condense']); assert.equal(f.calls(), 0);
  } finally { f.db.close(); }
});

test('a timed-out command aborts its transport and completes as unknown without retry', async () => {
  let aborted = false;
  const f = fixture(async (_id, signal) => new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  try {
    const relay = new MessageRelay(f.store, f.agent, { commandTimeoutMs: 10 });
    const row = await relay.acceptInbound(lane, command());
    await relay.integrateNextIntake('worker'); await relay.whenCommandsIdle();
    assert.equal(aborted, true); assert.equal(f.calls(), 1);
    assert.equal(f.store.getCommand(row.id)?.status, 'unknown'); assert.equal(receipts(f.db).length, 1);
  } finally { f.db.close(); }
});

test('a definite preflight rejection produces a receipt and allows later messages', async () => {
  const f = fixture(); try {
    f.agent.ensureConversation = async () => { throw Object.assign(new Error('private missing profile'), { nonRetryable: true, status: 404 }); };
    const row = await f.relay.acceptInbound(lane, command());
    await f.relay.integrateNextIntake('worker');
    assert.equal(f.store.getCommand(row.id)?.status, 'rejected'); assert.equal(receipts(f.db).length, 1);
    assert.equal(f.calls(), 0);
    f.agent.ensureConversation = async () => {};
    await f.relay.acceptInbound(lane, { sourceMessageId: 'next', content: 'continue' });
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'integrated');
  } finally { f.db.close(); }
});

test('exhausted safe preflight retries complete the command with a durable rejection instead of blocking the lane', async () => {
  const f = fixture(); try {
    const store = new MessageWorkStore(f.db, { maxAttempts: 1, baseBackoffMs: 1, capBackoffMs: 1, claimTtlMs: 100 });
    f.agent.ensureConversation = async () => { throw new Error('offline'); };
    const relay = new MessageRelay(store, f.agent);
    const row = await relay.acceptInbound(lane, command()); await relay.integrateNextIntake('worker');
    assert.equal(store.getCommand(row.id)?.status, 'rejected'); assert.equal(receipts(f.db).length, 1);
    assert.equal(f.calls(), 0);
  } finally { f.db.close(); }
});

test('receipt insertion failure rolls back outcome and completion; recovery produces a single truthful receipt', async () => {
  const f = fixture(); try {
    const row = await f.relay.acceptInbound(lane, command()); const claim = f.store.claimReady('worker', 1_000, 'intake')!;
    f.store.startCommand(claim, 1_000, 100);
    f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON work WHEN NEW.kind='delivery' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
    assert.throws(() => f.store.finishCommand(claim, 'succeeded', 1_050), /synthetic storage failure/);
    assert.equal(f.store.getCommand(row.id)?.status, 'attempted'); assert.equal(receipts(f.db).length, 0);
    f.db.exec('DROP TRIGGER fail_receipt'); f.store.reconcile(2_000);
    assert.equal(f.store.getCommand(row.id)?.status, 'unknown'); assert.equal(receipts(f.db).length, 1);
  } finally { f.db.close(); }
});


test('command intent and unknown recovery survive closing and reopening the SQLite database', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'relay-command-restart-')); const dbPath = path.join(root, 'relay.db');
  let db = new Database(dbPath);
  try {
    let store = new MessageWorkStore(db); store.resolveLane(lane, 'conversation', 1_000);
    const row = store.acceptIntake(lane.laneKey, { sourceKey: 'platform-message', agentEventId: 'request', payload: '/condense', command: { kind: 'condense' } }, 1_000);
    const claim = store.claimReady('old-process', 1_000, 'intake')!; store.startCommand(claim, 1_000, 500);
    db.close(); db = new Database(dbPath); store = new MessageWorkStore(db);
    assert.equal(store.getCommand(row.id)?.status, 'attempted'); store.reconcile(2_000);
    assert.equal(store.getCommand(row.id)?.status, 'unknown'); assert.equal(receipts(db).length, 1);
    assert.equal(store.finishCommand(claim, 'succeeded', 2_100), false);
    store.acceptIntake(lane.laneKey, { sourceKey: 'later', agentEventId: 'later', payload: 'continue' }, 2_200);
    assert.equal(store.claimReady('new-process', 2_200, 'intake')?.row.sourceKey, 'later');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('exhausted preflight rejection and its receipt are atomic even when receipt persistence fails', async () => {
  const f = fixture(); try {
    const store = new MessageWorkStore(f.db, { maxAttempts: 1, baseBackoffMs: 1, capBackoffMs: 1, claimTtlMs: 100 });
    await f.relay.acceptInbound(lane, command()); const claim = store.claimReady('worker', 1_000, 'intake')!;
    f.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON work WHEN NEW.kind='delivery' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    assert.throws(() => store.settle(claim, { kind: 'retry' }, 1_010), /synthetic receipt failure/);
    assert.equal(store.getCommand(claim.row.id)?.status, 'pending');
    assert.equal(store.listLaneWork(lane.laneKey, 'intake')[0].state, 'claimed');
    f.db.exec('DROP TRIGGER fail_receipt');
    assert.equal(store.settle(claim, { kind: 'retry' }, 1_020), 'done');
    assert.equal(store.getCommand(claim.row.id)?.status, 'rejected'); assert.equal(receipts(f.db).length, 1);
  } finally { f.db.close(); }
});

test('reconciliation repairs historical pending-command failed-intake crash state without another POST', async () => {
  const f = fixture(); try {
    const row = await f.relay.acceptInbound(lane, command());
    f.db.prepare("UPDATE work SET state='failed', claim_owner=NULL, claim_until=NULL WHERE id=?").run(row.id);
    const restored = new MessageWorkStore(f.db); restored.reconcile(2_000); restored.reconcile(3_000);
    assert.equal(restored.getCommand(row.id)?.status, 'rejected'); assert.equal(receipts(f.db).length, 1);
    await f.relay.acceptInbound(lane, { sourceMessageId: 'after-crash', content: 'continue' });
    assert.equal((await f.relay.integrateNextIntake('worker')).kind, 'integrated'); assert.equal(f.calls(), 0);
  } finally { f.db.close(); }
});
