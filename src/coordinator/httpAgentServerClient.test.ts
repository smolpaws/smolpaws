/**
 * HttpAgentServerClient request-shaping + error-classification tests, and composition with the
 * coordinator. The network boundary is stubbed (that is the unit's dependency, not the unit itself);
 * everything else is real.
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
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


test('new relay store cannot adopt another store conversation; same-store retry is safe', async () => {
  const make = (owner: string) => new HttpAgentServerClient({ baseUrl: 'http://h', conversationOwner: owner,
    fetch: async (_url, init) => init?.method === 'POST' ? json({}, 409) : json({ tags: { smolpaws_relay_owner: 'old-store' } }) });
  await assert.rejects(make('fresh-store').ensureConversation('c'), /another relay store/);
  await make('old-store').ensureConversation('c');
});

test('HTTP deadline includes a stalled response body', async () => {
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', requestTimeoutMs: 20,
    fetch: async (_url, init) => new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } })) });
  await assert.rejects(client.searchEvents('c', null, 10), /aborted/);
});

test('condense uses the protected upstream route with the same session key and no message append', async () => {
  const { fetchLike, calls } = stubFetch(() => json({ success: true }));
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', sessionApiKey: 'fixture-key', fetch: fetchLike });
  await client.condense('scope/id');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://h/api/conversations/scope%2Fid/condense');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['x-session-api-key'], 'fixture-key');
  assert.deepEqual(calls[0].body, {});
});

test('condense requires the upstream completed-success response rather than assuming any 2xx finished', async () => {
  for (const [body, status] of [[{}, 200], [{ success: false }, 200], [{ success: true }, 202]] as const) {
    const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async () => json(body, status) });
    await assert.rejects(client.condense('scope'), /unconfirmed/);
  }
});


test('condense supports Node 20 without AbortSignal.any and removes caller listeners after success', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    return json({ success: true });
  } });
  try {
    await client.condense('scope', caller.signal);
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    caller.abort(new Error('cancel after completion'));
    assert.equal(requestSignal?.aborted, false);
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
    else Reflect.deleteProperty(AbortSignal, 'any');
  }
});

test('an already-aborted caller does not send the non-idempotent condense request', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel before request');
  caller.abort(reason);
  let fetchCalls = 0;
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async () => {
    fetchCalls++;
    return json({ success: true });
  } });
  await assert.rejects(client.condense('scope', caller.signal), (error: unknown) => error === reason);
  assert.equal(fetchCalls, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('caller abort interrupts a pending fetch with the original reason and cleans up listeners', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel pending request');
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  const pending = client.condense('scope', caller.signal);
  caller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('caller abort remains connected while reading the body and preserves its reason', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel response body');
  let bodyReadStarted!: () => void;
  const bodyRead = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async (_url, init) =>
    new Response(new ReadableStream({
      start(controller) {
        const signal = init!.signal!;
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      pull() { bodyReadStarted(); },
    })) });
  const pending = client.condense('scope', caller.signal);
  await bodyRead;
  caller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('fetch failure removes caller listeners and does not replace the failure reason', async () => {
  const caller = new AbortController();
  const reason = new Error('network failed');
  let requestSignal: AbortSignal | undefined;
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    throw reason;
  } });
  await assert.rejects(client.condense('scope', caller.signal), (error: unknown) => error === reason);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  caller.abort(new Error('cancel after failure'));
  assert.equal(requestSignal?.aborted, false);
});

test('request deadline wins over later caller cancellation and removes caller listeners', async () => {
  const caller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const client = new HttpAgentServerClient({ baseUrl: 'http://h', fetch: async (_url, init) => {
    requestSignal = init!.signal!;
    return new Response(new ReadableStream({ start(controller) {
      requestSignal!.addEventListener('abort', () => controller.error(requestSignal!.reason), { once: true });
    } }));
  } });
  // Exercise the shared transport deadline without waiting for the three-minute command timeout.
  const transport = client as unknown as { request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> };
  await assert.rejects(transport.request('http://h', { signal: caller.signal }, 20), /Agent-server request timed out/);
  const timeoutReason: unknown = requestSignal?.reason;
  assert.equal(caller.signal.aborted, false);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  caller.abort(new Error('cancel after timeout'));
  assert.equal(requestSignal?.reason, timeoutReason);
});
