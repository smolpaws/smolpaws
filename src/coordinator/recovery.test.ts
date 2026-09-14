import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RunRecovery } from './runRecovery.js';
import { superviseServer } from './serverSupervisor.js';
import { MessageWorkStore } from './store.js';
import { MessageRelay } from './messageRelay.js';

test('server-unavailable intake commits locally; the worker retries without blocking the next chat', async () => {
  const db = new Database(':memory:'); const store = new MessageWorkStore(db); let calls = 0;
  const relay = new MessageRelay(store, { async ensureConversation() { calls++; throw new Error('offline'); }, async appendEvent() { throw new Error('unexpected'); }, async searchEvents() { return { items: [], nextPageId: null }; } });
  for (const id of ['a', 'b']) await relay.acceptInbound({ laneKey: id, platform: 'test', accountId: null, chatId: id, threadId: null }, { sourceMessageId: id, content: id });
  assert.equal(calls, 0); assert.equal((await relay.integrateNextIntake('worker')).kind, 'retry');
  assert.equal((await relay.integrateNextIntake('worker')).kind, 'retry'); assert.equal(calls, 2); db.close();
});
test('recovery survives restart and separates incomplete tools, complete observations and deliberate pauses', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'run-recovery-')); let db = new Database(path.join(root, 'relay.db')); let recovery = new RunRecovery(db);
  try {
    recovery.observe('c', { id: 'user', kind: 'MessageEvent', llm_message: { role: 'user' } });
    recovery.observe('c', { id: 'tool', kind: 'ActionEvent' }); db.close(); db = new Database(path.join(root, 'relay.db')); recovery = new RunRecovery(db);
    assert.deepEqual(recovery.pending(), [{ conversationId: 'c', actions: ['tool'] }]);
    recovery.park('c', 'reconcile'); assert.deepEqual(recovery.pending(), []);
    recovery.observe('c', { id: 'new-user', kind: 'MessageEvent', llm_message: { role: 'user' } });
    recovery.observe('c', { id: 'observation', kind: 'ObservationEvent', action_id: 'tool' });
    assert.deepEqual(recovery.pending(), [{ conversationId: 'c', actions: [] }]);
    recovery.observe('c', { id: 'pause', kind: 'PauseEvent' }); assert.deepEqual(recovery.pending(), []);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('the shared supervisor restarts a failed child and stops it without restarting again', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'server-supervisor-')); const file = path.join(root, 'starts');
  const script = `const fs=require('fs'); const f=process.argv[1]; let n=0;try {n=Number(fs.readFileSync(f,'utf8'));}catch{};fs.writeFileSync(f,String(n+1));if(n===0)process.exit(1);setInterval(()=>{},1000);`;
  const stop = superviseServer(process.execPath, ['-e', script, file], { delayMs: 10 });
  try {
    const deadline = Date.now() + 5000; let count = 0;
    while (Date.now() < deadline) { try { count = Number(readFileSync(file, 'utf8')); } catch {} if (count === 2) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(count, 2); await stop(); assert.equal(readFileSync(file, 'utf8'), '2');
  } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
});
