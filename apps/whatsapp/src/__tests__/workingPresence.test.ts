import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkingPresence } from '../workingPresence.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('refreshes real running work, aggregates overlapping lanes, and clears each terminal state', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const sent: [string, boolean][] = [];
  const presence = new WorkingPresence(async (chat, active) => { sent.push([chat, active]); }, error => assert.fail(String(error)));
  presence.connect();
  try {
    presence.observe('one', 'A', 'idle');
    presence.observe('scheduled', 'B', 'finished');
    await flush(); assert.equal(sent.length, 0);
    presence.observe('one', 'A', 'running');
    presence.observe('two', 'A', 'running');
    presence.observe('three', 'B', 'running');
    await flush(); assert.deepEqual(sent, [['A', true], ['B', true]]);
    // An interim delivery does not change execution. Refresh continues during gaps between messages.
    t.mock.timers.tick(5_000); await flush();
    assert.deepEqual(sent.slice(-2), [['A', true], ['B', true]]);
    presence.observe('one', 'A', 'finished'); await flush();
    assert.equal(sent.filter(([chat, active]) => chat === 'A' && !active).length, 0);
    presence.observe('two', 'A', 'paused'); await flush();
    assert.deepEqual(sent.at(-1), ['A', false]);
    for (const status of ['error', 'finished', 'idle', 'waiting_for_confirmation', 'unknown']) {
      presence.observe('three', 'B', 'running'); await flush();
      presence.observe('three', 'B', status); await flush();
      assert.deepEqual(sent.at(-1), ['B', false]);
    }
  } finally { presence.disconnect(); await flush(); }
});

test('expires stale status and reconnect requires fresh execution, not replay or acceptance', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const sent: boolean[] = [];
  const presence = new WorkingPresence(async (_chat, active) => { sent.push(active); }, error => assert.fail(String(error)));
  presence.connect(); presence.observe('one', 'A', 'running'); await flush();
  t.mock.timers.tick(15_000); await flush(); assert.equal(sent.at(-1), false);
  presence.observe('one', 'A', 'running'); await flush();
  presence.disconnect(); await flush(); assert.equal(sent.at(-1), false);
  const count = sent.length;
  presence.observe('one', 'A', 'running');
  presence.connect(); t.mock.timers.tick(5_000); await flush(); assert.equal(sent.length, count);
  presence.observe('one', 'A', 'running'); await flush(); assert.equal(sent.at(-1), true);
  presence.disconnect(); await flush();
  const stopped = sent.length;
  t.mock.timers.tick(60_000); await flush(); assert.equal(sent.length, stopped);
});

test('late composing completion cannot override a final status; failed sends are isolated', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const sent: [string, boolean][] = []; const errors: unknown[] = [];
  const presence = new WorkingPresence(async (chat, active) => {
    sent.push([chat, active]);
    if (chat === 'A' && active) await held;
    if (chat === 'B') throw new Error('offline');
  }, error => errors.push(error));
  presence.connect();
  presence.observe('one', 'A', 'running'); presence.observe('two', 'B', 'running'); await flush();
  presence.observe('one', 'A', 'finished'); await flush();
  assert.equal(sent.some(([chat, active]) => chat === 'A' && !active), false);
  release(); await flush(); assert.deepEqual(sent.at(-1), ['A', false]);
  assert.equal(errors.length, 1);
  presence.disconnect(); await flush();
});

test('a hung old-socket send cannot block or clear fresh presence after reconnect', async () => {
  let release!: () => void;
  const sent: boolean[] = [];
  const presence = new WorkingPresence(async (_chat, active) => {
    sent.push(active);
    if (sent.length === 1) await new Promise<void>(resolve => { release = resolve; });
  }, error => assert.fail(String(error)));
  presence.connect(); presence.observe('one', 'A', 'running'); await flush();
  presence.disconnect(); presence.connect();
  presence.observe('one', 'A', 'running'); await flush();
  assert.deepEqual(sent, [true, false, true]);
  release(); await flush(); assert.deepEqual(sent, [true, false, true]);
  presence.disconnect(); await flush(); assert.equal(sent.at(-1), false);
});

test('a failed pause is retried without an idle composing pulse', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const sent: boolean[] = []; let fail = true;
  const presence = new WorkingPresence(async (_chat, active) => {
    sent.push(active); if (!active && fail) throw new Error('temporary');
  }, () => {});
  presence.connect(); presence.observe('one', 'A', 'running'); await flush();
  presence.observe('one', 'A', 'finished'); await flush();
  fail = false; t.mock.timers.tick(5_000); await flush();
  assert.deepEqual(sent, [true, false, false]);
  t.mock.timers.tick(5_000); await flush(); assert.deepEqual(sent, [true, false, false]); presence.disconnect();
});

test('a hung composing write has a bounded lifetime so final pause can be sent', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const sent: boolean[] = [];
  const presence = new WorkingPresence(async (_chat, active) => {
    sent.push(active); if (active) await new Promise<void>(() => {});
  }, () => {});
  presence.connect(); presence.observe('one', 'A', 'running'); await flush();
  presence.observe('one', 'A', 'finished');
  t.mock.timers.tick(5_000); await flush(); assert.deepEqual(sent, [true, false]); presence.disconnect();
});

test('failed composing refresh retries, and stale status clears even after failures', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 0 });
  const sent: boolean[] = []; let fail = true;
  const presence = new WorkingPresence(async (_chat, active) => {
    sent.push(active); if (active && fail) throw new Error('temporary');
  }, () => {});
  presence.connect(); presence.observe('one', 'A', 'running'); await flush();
  fail = false; t.mock.timers.tick(5_000); await flush(); assert.deepEqual(sent, [true, true]);
  t.mock.timers.tick(10_000); await flush(); assert.equal(sent.at(-1), false);
  presence.disconnect();
});
