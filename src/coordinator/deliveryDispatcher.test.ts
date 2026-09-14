import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { DeliveryDispatcher, DeliveryTargetRegistry, type DeliveryTarget } from './deliveryDispatcher.js';
import { MessageWorkStore } from './store.js';
import type { LaneDescriptor } from './types.js';

const lane: LaneDescriptor = { laneKey: 'whatsapp:acct:chat', platform: 'whatsapp', accountId: 'acct', chatId: 'chat', threadId: null };

function makeTarget(ready: () => boolean, sent: unknown[]): DeliveryTarget {
  return {
    isReady: ready,
    validate() {},
    async deliver(_lane, payload) {
      sent.push(payload);
      return { externalMessageId: `ext-${sent.length}` };
    },
  };
}

test('a delivery claimed while the transport is down is released untouched and sent once it is up', async () => {
  const db = new Database(':memory:');
  const store = new MessageWorkStore(db);
  let now = 1_000;
  let ready = false;
  const sent: unknown[] = [];
  const targets = new DeliveryTargetRegistry();
  targets.register('whatsapp', makeTarget(() => ready, sent));
  const dispatcher = new DeliveryDispatcher(store, targets, { now: () => now });

  store.resolveLane(lane, 'conv-1', now);
  const row = store.insertDelivery({ sourceKey: 'e1:whatsapp:acct:chat', laneKey: lane.laneKey, agentEventId: 'e1', payload: { text: 'hi' } }, now);

  const down = await dispatcher.dispatchNext('w1');
  assert.deepEqual(down, { kind: 'transport_unavailable', workId: row.id });
  let current = store.getWork(row.id)!;
  assert.equal(current.state, 'ready');
  assert.equal(current.attempts, 0);
  assert.equal(current.sendAttempted, false);
  assert.equal(current.claimOwner, null);
  assert.deepEqual(sent, []);

  // Still down on a later tick: still no attempt burned, no backoff applied.
  now += 60_000;
  assert.equal((await dispatcher.dispatchNext('w1')).kind, 'transport_unavailable');
  current = store.getWork(row.id)!;
  assert.equal(current.state, 'ready');
  assert.equal(current.attempts, 0);

  ready = true;
  now += 1;
  const up = await dispatcher.dispatchNext('w1');
  assert.deepEqual(up, { kind: 'delivered', workId: row.id, externalMessageId: 'ext-1' });
  current = store.getWork(row.id)!;
  assert.equal(current.state, 'done');
  assert.equal(current.sendAttempted, true);
  assert.deepEqual(sent, [{ text: 'hi' }]);
  assert.equal((await dispatcher.dispatchNext('w1')).kind, 'idle');
  db.close();
});

test('release only applies to the live claim', () => {
  const db = new Database(':memory:');
  const store = new MessageWorkStore(db);
  store.resolveLane(lane, 'conv-1', 0);
  store.insertDelivery({ sourceKey: 'e2:whatsapp:acct:chat', laneKey: lane.laneKey, agentEventId: 'e2', payload: {} }, 0);
  const claim = store.claimReady('w1', 1, 'delivery')!;
  assert.equal(store.release(claim, 2), 'ready');
  assert.equal(store.release(claim, 3), null);
  const again = store.claimReady('w2', 4, 'delivery')!;
  assert.equal(again.row.id, claim.row.id);
  assert.notEqual(again.generation, claim.generation);
  assert.equal(store.release({ ...again, generation: claim.generation }, 5), null);
  assert.equal(store.release(again, 6), 'ready');
  db.close();
});

test('a stalled send becomes delivery_unknown once and never automatically retries', async () => {
  const db = new Database(':memory:'); const store = new MessageWorkStore(db); const targets = new DeliveryTargetRegistry();
  let sends = 0; targets.register('whatsapp', { validate() {}, deliver() { sends++; return new Promise(() => {}); } });
  store.resolveLane(lane, 'conversation', Date.now());
  const row = store.insertDelivery({ sourceKey: 'timeout', laneKey: lane.laneKey, agentEventId: 'timeout', payload: {} }, Date.now());
  const dispatcher = new DeliveryDispatcher(store, targets, { sendTimeoutMs: 10 });
  assert.equal((await dispatcher.dispatchNext('worker')).kind, 'delivery_unknown');
  assert.equal(store.getWork(row.id)?.state, 'delivery_unknown');
  assert.equal((await dispatcher.dispatchNext('worker')).kind, 'idle'); assert.equal(sends, 1); db.close();
});
