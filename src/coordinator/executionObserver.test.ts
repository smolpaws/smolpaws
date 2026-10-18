import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionObserver } from './executionObserver.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const entry = (id: string) => ({ conversationId: id, lane: { laneKey: id, chatId: id, platform: 'test' } });

test('canonical polling reconciles restarts and idle/background waiting without replay pulses', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  let lanes = [entry('one'), entry('two')];
  const states: Record<string, string> = { one: 'running', two: 'finished' };
  const observations: [string, string][] = []; const calls: string[] = [];
  const observer = new ExecutionObserver({ lanes: () => lanes,
    status: async id => { calls.push(id); return states[id]; },
    observe: (lane, status) => observations.push([lane.chatId, status]), onError: error => assert.fail(String(error)) });
  observer.start(); await flush();
  assert.deepEqual(observations, [['one', 'running'], ['two', 'finished']]);
  observer.refresh(); await flush(); assert.equal(calls.length, 2);
  states.one = 'paused'; t.mock.timers.tick(5_000); await flush();
  assert.deepEqual(observations.slice(-2), [['one', 'paused'], ['two', 'finished']]);
  lanes = [entry('two')]; observer.refresh(); await flush();
  assert.deepEqual(observations.at(-1), ['one', 'unknown']);
  observer.stop(); assert.deepEqual(observations.at(-1), ['two', 'unknown']);
  const count = calls.length; t.mock.timers.tick(60_000); await flush(); assert.equal(calls.length, count);
});

test('hanging or failed status calls do not block other lanes; stop aborts and fences late results', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  let release!: (status: string) => void; let signal!: AbortSignal;
  const observations: [string, string][] = []; const errors: unknown[] = []; const calls: string[] = [];
  const observer = new ExecutionObserver({ lanes: () => ['slow', 'bad', 'good'].map(entry),
    status: async (id, abort) => {
      calls.push(id);
      if (id === 'slow') { signal = abort; return new Promise<string>(resolve => { release = resolve; }); }
      if (id === 'bad') throw new Error('offline');
      return 'running';
    }, observe: (lane, status) => observations.push([lane.chatId, status]), onError: error => errors.push(error) });
  observer.start(); await flush();
  assert.ok(observations.some(([id, status]) => id === 'good' && status === 'running'));
  assert.ok(observations.some(([id, status]) => id === 'bad' && status === 'unknown'));
  assert.equal(errors.length, 1);
  t.mock.timers.tick(5_000); await flush(); assert.equal(calls.filter(id => id === 'slow').length, 1);
  observer.stop(); assert.equal(signal.aborted, true);
  const count = observations.length; release('running'); await flush(); assert.equal(observations.length, count);
});

test('a removed and re-added lane cannot publish the old request result', async () => {
  let lanes = [entry('one')];
  let release!: (status: string) => void;
  const observations: string[] = [];
  const observer = new ExecutionObserver({ lanes: () => lanes,
    status: async () => new Promise<string>(resolve => { release = resolve; }),
    observe: (_lane, status) => observations.push(status), onError: error => assert.fail(String(error)) });
  observer.refresh(); await flush(); lanes = []; observer.refresh();
  release('running'); await flush(); assert.deepEqual(observations, ['unknown']); observer.stop();
});

test('reconnect discards a pre-disconnect snapshot and immediately reads current state', async () => {
  const pending: ((status: string) => void)[] = [];
  const observations: string[] = [];
  const observer = new ExecutionObserver({ lanes: () => [entry('one')],
    status: async () => new Promise<string>(resolve => pending.push(resolve)),
    observe: (_lane, status) => observations.push(status), onError: error => assert.fail(String(error)) });
  observer.start(); await flush(); observer.reconcile(); await flush();
  assert.equal(pending.length, 2);
  pending[0]('running'); await flush(); assert.equal(observations.length, 0);
  pending[1]('finished'); await flush(); assert.deepEqual(observations, ['finished']); observer.stop();
});
