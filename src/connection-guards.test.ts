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

test('replaceGroupSyncInterval replaces the previous timer', (t) => {
  const guards = new ConnectionGuards();
  let callCountA = 0;
  let callCountB = 0;

  // First interval
  guards.replaceGroupSyncInterval(() => { callCountA++; }, 10);
  const firstTimerId = guards.groupSyncTimerId;
  assert.ok(firstTimerId !== undefined, 'timer should be set');

  // Replace with second interval
  guards.replaceGroupSyncInterval(() => { callCountB++; }, 10);
  const secondTimerId = guards.groupSyncTimerId;
  assert.ok(secondTimerId !== undefined, 'timer should still be set');
  assert.notEqual(firstTimerId, secondTimerId, 'timer ID should change');

  guards.dispose();
});

test('dispose clears the group sync interval', () => {
  const guards = new ConnectionGuards();
  guards.replaceGroupSyncInterval(() => {}, 10);
  assert.ok(guards.groupSyncTimerId !== undefined);

  guards.dispose();
  assert.equal(guards.groupSyncTimerId, undefined);
});
