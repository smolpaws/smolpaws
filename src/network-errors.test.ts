import assert from 'node:assert/strict';
import test from 'node:test';
import { isTransientNetworkError } from './network-errors.js';

test('detects the undici socket error that crashed the bridge', () => {
  // The exact shape seen in the crash log: an outer error with a cause carrying
  // UND_ERR_SOCKET, thrown when WhatsApp closed the CDN socket mid-download.
  const err = Object.assign(new Error('terminated'), {
    cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' },
  });
  assert.equal(isTransientNetworkError(err), true);
});

test('detects transient errors by top-level code', () => {
  for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE']) {
    assert.equal(isTransientNetworkError({ code }), true, `code ${code} should be transient`);
  }
});

test('detects transient errors by message text', () => {
  for (const message of ['Client network socket disconnected', 'socket hang up', 'terminated', 'other side closed']) {
    assert.equal(isTransientNetworkError(new Error(message)), true, `message "${message}" should be transient`);
  }
});

test('does NOT swallow real (non-network) errors', () => {
  assert.equal(isTransientNetworkError(new TypeError('cannot read property foo of undefined')), false);
  assert.equal(isTransientNetworkError(new Error('validation failed: bad input')), false);
  assert.equal(isTransientNetworkError({ code: 'ENOENT', message: 'file not found' }), false);
});

test('handles null / undefined / non-error values safely', () => {
  assert.equal(isTransientNetworkError(undefined), false);
  assert.equal(isTransientNetworkError(null), false);
  assert.equal(isTransientNetworkError('some string'), false);
  assert.equal(isTransientNetworkError(42), false);
});

test('does not throw on non-string code/message (classifier must never crash)', () => {
  // The classifier runs inside the crash guard, so it must tolerate any shape.
  assert.doesNotThrow(() => isTransientNetworkError({ message: 12345 }));
  assert.doesNotThrow(() => isTransientNetworkError({ message: { nested: 'obj' } }));
  assert.doesNotThrow(() => isTransientNetworkError({ code: 500 }));
  assert.doesNotThrow(() => isTransientNetworkError({ cause: { code: null } }));
  assert.equal(isTransientNetworkError({ message: 12345, code: 42 }), false);
});
