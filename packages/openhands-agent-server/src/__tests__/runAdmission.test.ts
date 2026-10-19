import { describe, expect, test } from 'vitest';
import { RunAdmission, ConversationRunLimitExceeded } from '../runAdmission.js';

describe('shared conversation admission', () => {
  test('public reservations are atomic and shared owners return one token once', () => {
    const pool = new RunAdmission(1);
    const first = pool.tryAcquire();
    const shared = first.share();
    expect(() => pool.tryAcquire()).toThrow(ConversationRunLimitExceeded);
    first.release();
    expect(() => pool.tryAcquire()).toThrow(ConversationRunLimitExceeded);
    expect(first.release()).toBe(false);
    shared.release();
    expect(() => shared.share()).toThrow();
    pool.tryAcquire().release();
  });
  test('accepted continuations take released capacity FIFO ahead of public calls', async () => {
    const pool = new RunAdmission(1);
    const active = pool.tryAcquire();
    const first = pool.acquire();
    const second = pool.acquire();
    active.release();
    expect(() => pool.tryAcquire()).toThrow(ConversationRunLimitExceeded);
    (await first).release();
    (await second).release();
    pool.tryAcquire().release();
  });
  test('cancelling a waiter does not free an executing owner or consume its next token', async () => {
    const pool = new RunAdmission(1);
    const active = pool.tryAcquire();
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    const rejection = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(() => pool.tryAcquire()).toThrow(ConversationRunLimitExceeded);
    active.release();
    pool.tryAcquire().release();
  });
  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid maximum %s', maximum => {
    expect(() => new RunAdmission(maximum)).toThrow('positive integer');
  });
});
