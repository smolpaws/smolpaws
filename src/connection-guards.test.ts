import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionGuards } from './connection-guards.js';

test('tryStartMessageLoop returns true only on first call', () => {
  const guards = new ConnectionGuards();
  assert.equal(guards.tryStartMessageLoop(), true);
  assert.equal(guards.tryStartMessageLoop(), false);
  assert.equal(guards.tryStartMessageLoop(), false);
});

test('tryStartScheduler returns true only on first call', () => {
  const guards = new ConnectionGuards();
  assert.equal(guards.tryStartScheduler(), true);
  assert.equal(guards.tryStartScheduler(), false);
  assert.equal(guards.tryStartScheduler(), false);
});

test('simulated reconnections do not spawn duplicate loops', () => {
  const guards = new ConnectionGuards();
  let messageLoopStarts = 0;
  let schedulerStarts = 0;

  // Simulate 5 reconnection events
  for (let i = 0; i < 5; i++) {
    if (guards.tryStartMessageLoop()) messageLoopStarts++;
    if (guards.tryStartScheduler()) schedulerStarts++;
  }

  assert.equal(messageLoopStarts, 1, 'message loop should start exactly once');
  assert.equal(schedulerStarts, 1, 'scheduler should start exactly once');
});

test('replaceGroupSyncInterval stops the previous timer', async () => {
  const guards = new ConnectionGuards();
  let callCountA = 0;
  let callCountB = 0;

  guards.replaceGroupSyncInterval(() => { callCountA++; }, 10);
  // Replace before A fires
  guards.replaceGroupSyncInterval(() => { callCountB++; }, 10);

  // Wait enough for several ticks
  await new Promise((resolve) => setTimeout(resolve, 60));

  guards.dispose();

  assert.equal(callCountA, 0, 'old timer callback should never fire after replacement');
  assert.ok(callCountB > 0, 'new timer callback should have fired');
});

test('dispose stops the timer callback from firing', async () => {
  const guards = new ConnectionGuards();
  let callCount = 0;

  guards.replaceGroupSyncInterval(() => { callCount++; }, 10);
  guards.dispose();

  // Wait and verify no further calls
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(callCount, 0, 'callback should not fire after dispose');
});
