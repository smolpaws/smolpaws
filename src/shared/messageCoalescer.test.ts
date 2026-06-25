import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageCoalescer } from './messageCoalescer.js';

/**
 * Deterministic fake clock: timers fire only when advance() crosses their due
 * time, so tests control exactly when debounce windows elapse.
 */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; cb: () => void }>();

  return {
    now: () => now,
    setTimer: (cb: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { due: now + ms, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number);
    },
    advance: (ms: number) => {
      now += ms;
      // Fire all timers now due, earliest first.
      const due = [...timers.entries()]
        .filter(([, t]) => t.due <= now)
        .sort((a, b) => a[1].due - b[1].due);
      for (const [id, t] of due) {
        timers.delete(id);
        t.cb();
      }
    },
    pendingTimers: () => timers.size,
  };
}

test('windowMs <= 0 disables coalescing: each submit flushes immediately', () => {
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 0 });
  assert.equal(c.enabled, false);

  c.submit('conv-1', 'hello', async (text) => { flushed.push(text); });
  c.submit('conv-1', 'world', async (text) => { flushed.push(text); });

  assert.deepEqual(flushed, ['hello', 'world']);
  assert.equal(c.pendingCount, 0);
});

test('single message flushes after the window with its own text', () => {
  const clock = createFakeClock();
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('conv-1', 'only message', async (text) => { flushed.push(text); });
  assert.equal(c.pendingCount, 1);
  assert.deepEqual(flushed, []); // nothing yet — window still open

  clock.advance(1000);
  assert.deepEqual(flushed, ['only message']);
  assert.equal(c.pendingCount, 0);
});

test('rapid messages within the window coalesce into one flush, newline-joined', () => {
  const clock = createFakeClock();
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('conv-1', 'first', async (text) => { flushed.push(text); });
  clock.advance(300);
  c.submit('conv-1', 'second', async (text) => { flushed.push(text); });
  clock.advance(300);
  c.submit('conv-1', 'third', async (text) => { flushed.push(text); });

  // Not yet — last submit reset the timer; only 600ms elapsed since first,
  // 0 since third.
  assert.deepEqual(flushed, []);

  clock.advance(1000); // window elapses after the third
  assert.deepEqual(flushed, ['first\nsecond\nthird']);
  assert.equal(c.pendingCount, 0);
});

test('each submission resets the debounce window (trailing debounce)', () => {
  const clock = createFakeClock();
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('c', 'a', async (t) => { flushed.push(t); });
  clock.advance(900);
  c.submit('c', 'b', async (t) => { flushed.push(t); });
  clock.advance(900); // 1800ms since first, but only 900 since second
  assert.deepEqual(flushed, []); // still buffered — window keeps resetting
  clock.advance(100); // now 1000ms since second
  assert.deepEqual(flushed, ['a\nb']);
});

test('the latest flush wins so the reply targets the most recent message', () => {
  const clock = createFakeClock();
  const calls: string[] = [];
  const c = new MessageCoalescer({ windowMs: 500, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('c', 'older', async (text) => { calls.push(`old-ctx:${text}`); });
  c.submit('c', 'newer', async (text) => { calls.push(`new-ctx:${text}`); });

  clock.advance(500);
  // Combined text, delivered through the newer message's flush closure.
  assert.deepEqual(calls, ['new-ctx:older\nnewer']);
});

test('distinct conversations are buffered and flushed independently', () => {
  const clock = createFakeClock();
  const flushed: Array<[string, string]> = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('a', 'a1', async (t) => { flushed.push(['a', t]); });
  c.submit('b', 'b1', async (t) => { flushed.push(['b', t]); });
  clock.advance(500);
  c.submit('a', 'a2', async (t) => { flushed.push(['a', t]); });

  assert.equal(c.pendingCount, 2);

  clock.advance(500); // b's window (1000) elapses; a was reset at 500 so not yet
  assert.deepEqual(flushed, [['b', 'b1']]);

  clock.advance(500); // a's window elapses
  assert.deepEqual(flushed, [['b', 'b1'], ['a', 'a1\na2']]);
});

test('flushKey flushes a conversation immediately and cancels its timer', () => {
  const clock = createFakeClock();
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('c', 'x', async (t) => { flushed.push(t); });
  c.flushKey('c');
  assert.deepEqual(flushed, ['x']);
  assert.equal(c.pendingCount, 0);
  assert.equal(clock.pendingTimers(), 0); // timer was cleared

  clock.advance(1000); // no double-flush
  assert.deepEqual(flushed, ['x']);
});

test('flushKey on an unknown conversation is a no-op', () => {
  const c = new MessageCoalescer({ windowMs: 1000 });
  c.flushKey('does-not-exist'); // must not throw
  assert.equal(c.pendingCount, 0);
});

test('clear() drops pending bursts without flushing and cancels timers', () => {
  const clock = createFakeClock();
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('a', 'a1', async (t) => { flushed.push(t); });
  c.submit('b', 'b1', async (t) => { flushed.push(t); });
  assert.equal(c.pendingCount, 2);

  c.clear();
  assert.equal(c.pendingCount, 0);
  assert.equal(clock.pendingTimers(), 0);

  clock.advance(1000);
  assert.deepEqual(flushed, []); // nothing fired
});

test('a new burst starts cleanly after a previous one flushed', () => {
  const clock = createFakeClock();
  const flushed: string[] = [];
  const c = new MessageCoalescer({ windowMs: 1000, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  c.submit('c', 'first-batch', async (t) => { flushed.push(t); });
  clock.advance(1000);
  assert.deepEqual(flushed, ['first-batch']);

  c.submit('c', 'second-batch', async (t) => { flushed.push(t); });
  clock.advance(1000);
  assert.deepEqual(flushed, ['first-batch', 'second-batch']);
});

test('a rejecting flush is routed to onError instead of throwing', async () => {
  const clock = createFakeClock();
  const errors: Array<{ key: string; message: string }> = [];
  const c = new MessageCoalescer({
    windowMs: 100,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (err, key) => errors.push({ key, message: (err as Error).message }),
  });

  c.submit('c', 'boom', async () => { throw new Error('dispatch failed'); });
  clock.advance(100);
  // Let the rejected promise settle.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, [{ key: 'c', message: 'dispatch failed' }]);
});
