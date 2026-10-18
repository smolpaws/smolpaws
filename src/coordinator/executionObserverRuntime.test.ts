import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import { RelayRuntime } from './relayRuntime.js';

test('a hung execution snapshot cannot block real HTTP intake/outbound, and stop aborts it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'presence-runtime-'));
  let held: ServerResponse | undefined;
  const delivered: string[] = []; const snapshots: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers['x-session-api-key'], 'presence-test');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/conversations/presence-test') { held = response; return; }
    response.end(JSON.stringify(request.url?.includes('/events/search') ? { items: [], next_page_id: null } : { success: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = new RelayRuntime({ platform: 'test', serverUrl: `http://127.0.0.1:${address.port}`,
    sessionApiKey: 'presence-test', logger: pino({ level: 'silent' }), dbPath: path.join(root, 'relay.db'), tickMs: 60_000,
    onExecutionStatus: (_lane, status) => snapshots.push(status), deriveConversationId: () => 'presence-test',
    target: { validate() {}, async deliver(_lane, payload) { delivered.push((payload as { text: string }).text); return {}; } } });
  try {
    await runtime.start();
    await runtime.accept({ lane: { laneKey: 'one', platform: 'test', chatId: 'one' }, message: { sourceMessageId: 'message', content: 'hi' } });
    const deadline = Date.now() + 2_000;
    while (!held && Date.now() < deadline) { await runtime.runOnce(); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(held);
    runtime.workStore.insertDelivery({ sourceKey: 'notice', laneKey: 'one', agentEventId: 'notice',
      payload: { kind: 'current_thread_message', text: 'STILL DELIVERS' } }, Date.now());
    await runtime.runOnce(); assert.deepEqual(delivered, ['STILL DELIVERS']);
    const start = Date.now(); await runtime.stop(); assert.ok(Date.now() - start < 1_000);
    assert.deepEqual(snapshots, ['unknown']);
  } finally {
    await runtime.stop(); held?.end('{}'); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
  }
});
