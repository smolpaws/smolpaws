/**
 * HttpAgentServerClient request-shaping + error-classification tests, and composition with the
 * coordinator. The network boundary is stubbed (that is the unit's dependency, not the unit itself);
 * everything else is real.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MessageRelay } from './messageRelay.js';
import { HttpAgentServerClient, HttpAgentServerError } from './httpAgentServerClient.js';
import { deterministicEventId } from './ids.js';
import { MessageWorkStore } from './store.js';
import type { LaneDescriptor, RetryPolicy } from './types.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(responder: (rec: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : init?.body ?? null,
      headers,
    };
    calls.push(rec);
    return responder(rec);
  };
  return { fetchLike, calls };
}

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('ensureConversation posts the id and treats 409 as already-exists', async () => {
  const { fetchLike, calls } = stubFetch((rec) => (rec.url.endsWith('/api/conversations') ? json({}, 409) : json({})));
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', sessionApiKey: 'k', fetch: fetchLike });
  await client.ensureConversation('conv-1'); // must not throw on 409
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { id: 'conv-1' });
  assert.equal(calls[0].headers['x-session-api-key'], 'k');
});

test('appendEvent sends event_id/role/content/run and parses created', async () => {
  const { fetchLike, calls } = stubFetch(() => json({ success: true, event_id: 'ev-x', created: false }));
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: fetchLike });
  const result = await client.appendEvent('conv-1', { eventId: 'ev-x', role: 'user', content: 'hi', run: true });
  assert.deepEqual(calls[0].body, { event_id: 'ev-x', role: 'user', content: 'hi', run: true });
  assert.deepEqual(result, { eventId: 'ev-x', created: false });
});

test('appendEvent falls back to created:true when the server predates the delta', async () => {
  const { fetchLike } = stubFetch(() => json({ success: true })); // no event_id/created
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: fetchLike });
  const result = await client.appendEvent('c', { eventId: 'ev-x', role: 'user', content: 'hi', run: true });
  assert.deepEqual(result, { eventId: 'ev-x', created: true });
});

test('searchEvents builds page_id/limit/kind and parses items + next_page_id', async () => {
  const { fetchLike, calls } = stubFetch(() => json({ items: [{ id: 'e1', kind: 'ActionEvent' }], next_page_id: '2' }));
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: fetchLike, searchKind: 'ActionEvent' });
  const page = await client.searchEvents('conv-1', '0', 50);
  const u = new URL(calls[0].url);
  assert.equal(u.searchParams.get('page_id'), '0');
  assert.equal(u.searchParams.get('limit'), '50');
  assert.equal(u.searchParams.get('kind'), 'ActionEvent');
  assert.equal(page.items[0]?.id, 'e1');
  assert.equal(page.nextPageId, '2');
});

test('4xx is a non-retryable error; 5xx is retryable', async () => {
  const bad = stubFetch(() => json({ detail: 'bad request' }, 400));
  const c1 = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: bad.fetchLike });
  await assert.rejects(
    c1.appendEvent('c', { eventId: 'e', role: 'user', content: 'x', run: true }),
    (e: unknown) => e instanceof HttpAgentServerError && e.nonRetryable === true && e.status === 400,
  );

  const down = stubFetch(() => json({ detail: 'boom' }, 503));
  const c2 = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: down.fetchLike });
  await assert.rejects(
    c2.appendEvent('c', { eventId: 'e', role: 'user', content: 'x', run: true }),
    (e: unknown) => e instanceof HttpAgentServerError && e.nonRetryable === false && e.status === 503,
  );
});

// ---- composition with the coordinator --------------------------------------------------------------

const POLICY: RetryPolicy = { maxAttempts: 3, baseBackoffMs: 1_000, capBackoffMs: 8_000, claimTtlMs: 1_000 };
const lane = (): LaneDescriptor => ({ laneKey: 'channel:slack:T1:C1:root', platform: 'slack', accountId: 'T1', chatId: 'C1', threadId: null });

test('coordinator drives the http client: deterministic append, non-retryable maps to failed', async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'mwc-http-')), 'c.db');
  const store = new MessageWorkStore(new Database(dbPath), POLICY);
  let t = Date.UTC(2026, 0, 1);

  // Happy path: ensure + append succeed.
  const ok = stubFetch((rec) => (rec.url.includes('/events') ? json({ success: true, event_id: (rec.body as { event_id: string }).event_id, created: true }) : json({})));
  const okClient = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: ok.fetchLike });
  const coord = new MessageRelay(store, okClient, { now: () => t });
  await coord.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hello' });
  const outcome = await coord.integrateNextIntake('w1');
  assert.equal(outcome.kind, 'integrated');
  const appendCall = ok.calls.find((c) => c.url.includes('/events'))!;
  assert.equal((appendCall.body as { event_id: string }).event_id, deterministicEventId('slack', 'm1'));

  // Non-retryable append (4xx) must fail the intake, not loop forever.
  const store2 = new MessageWorkStore(new Database(path.join(mkdtempSync(path.join(tmpdir(), 'mwc-http2-')), 'c.db')), POLICY);
  const bad = stubFetch((rec) => (rec.url.includes('/events') ? json({ detail: 'conflict' }, 409) : json({})));
  const coord2 = new MessageRelay(store2, new HttpAgentServerClient({ baseUrl: 'http://h', fetch: bad.fetchLike }), { now: () => t });
  await coord2.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hello' });
  assert.equal((await coord2.integrateNextIntake('w1')).kind, 'failed');
});
