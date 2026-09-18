import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import { RelayRuntime } from './relayRuntime.js';

// A real HTTP transport and real relay SQLite prove pump behavior while the backend holds a summary.
test('shared runtime keeps outbound and other lanes moving during a protected condensation request', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'command-runtime-'));
  let held: ServerResponse | undefined; const paths: string[] = []; const delivered: string[] = [];
  const http = createServer((request, response) => {
    paths.push(request.url!); assert.equal(request.headers['x-session-api-key'], 'test-key');
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/condense')) { held = response; return; }
    response.end(JSON.stringify(request.url?.includes('/events/search') ? { items: [], next_page_id: null } : { success: true }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const runtime = new RelayRuntime({ platform: 'test', serverUrl: `http://127.0.0.1:${address.port}`, sessionApiKey: 'test-key',
    logger: pino({ level: 'silent' }), dbPath: path.join(root, 'relay.db'), schedulerDbPath: path.join(root, 'scheduler.db'),
    target: { validate() {}, async deliver(_lane, payload) { delivered.push((payload as { text: string }).text); return {}; } } });
  const lane = (id: string) => ({ laneKey: id, platform: 'test', chatId: id });
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (!predicate() && Date.now() < deadline) { await runtime.runOnce(); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(predicate(), true);
  };
  try {
    await runtime.accept({ lane: lane('command'), message: { sourceMessageId: 'c', content: '/condense', command: { kind: 'condense' } } });
    await wait(() => held !== undefined);
    await runtime.accept({ lane: lane('other'), message: { sourceMessageId: 'm', content: 'ordinary' } });
    await wait(() => paths.some(url => url.endsWith('/events')));
    runtime.workStore.insertDelivery({ sourceKey: 'fixture-notice', laneKey: 'other', agentEventId: 'fixture',
      payload: { kind: 'current_thread_message', text: 'OTHER-NOTICE' } }, Date.now());
    await runtime.runOnce(); assert.deepEqual(delivered, ['OTHER-NOTICE']);
    held!.end(JSON.stringify({ success: true }));
    await wait(() => delivered.includes('Conversation condensed.'));
    assert.equal(paths.filter(url => url.endsWith('/condense')).length, 1);
    await runtime.accept({ lane: lane('command'), message: { sourceMessageId: 'c', content: '/condense', command: { kind: 'condense' } } });
    await runtime.runOnce(); assert.equal(paths.filter(url => url.endsWith('/condense')).length, 1);
  } finally {
    held?.end(JSON.stringify({ success: true })); await runtime.stop();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
