import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRelayDbPath } from './relayPaths.js';

test('native relay stays beside its scheduler and ignores a bridge override', () => {
  const previous = process.env.SMOLPAWS_RELAY_DB_PATH;
  process.env.SMOLPAWS_RELAY_DB_PATH = '/private/canary/whatsapp-relay.db';
  try {
    assert.equal(nativeRelayDbPath('/private/canary/scheduler.db', ''), '/private/canary/agent-server-relay-v1.db');
    assert.equal(nativeRelayDbPath('/private/canary/scheduler.db', ' /private/native.db '), '/private/native.db');
  } finally {
    if (previous === undefined) delete process.env.SMOLPAWS_RELAY_DB_PATH;
    else process.env.SMOLPAWS_RELAY_DB_PATH = previous;
  }
});
