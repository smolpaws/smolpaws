import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { WhatsAppBridge, type ConnectionUpdate, type WhatsAppSocketLike } from '../adapter.js';
import { loadConfig } from '../config.js';

test('socket creation failures keep retrying and stale sockets cannot reconnect after stop', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wa-reconnect-')); const handlers: ((update: ConnectionUpdate) => void)[] = [];
  let calls = 0;
  const bridge = new WhatsAppBridge({ logger: pino({ level: 'silent' }), serverUrl: 'http://127.0.0.1:1', startupPing: false,
    config: loadConfig({ SMOLPAWS_HOME_DIR: root }, root), socketFactory: async () => {
      calls++; if (calls === 2) throw new Error('transient socket creation failure');
      const socket: WhatsAppSocketLike = { ev: { on: ((event: string, callback: unknown) => { if (event === 'connection.update') handlers.push(callback as (update: ConnectionUpdate) => void); }) as WhatsAppSocketLike['ev']['on'] },
        async sendMessage() { return undefined; }, async sendPresenceUpdate() {}, async groupFetchAllParticipating() { return {}; } };
      return { socket, saveCreds() {} };
    } });
  try {
    await bridge.start(); handlers[0]({ connection: 'close' });
    const deadline = Date.now() + 5000;
    while (calls < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 3); await bridge.stop();
    handlers[0]({ connection: 'close' }); handlers[1]({ connection: 'close' });
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls, 3);
  } finally { await bridge.stop(); rmSync(root, { recursive: true, force: true }); }
});
