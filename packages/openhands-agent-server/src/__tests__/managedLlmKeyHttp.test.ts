import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createClientFromProfile, InMemorySecretStore, llmProfileSchema, llmProviderSecretRef } from '@smolpaws/openhands-agent';
import { createManagedLlmKeyRefreshHook } from '../managedLlmKey.js';
import { createAgentServerApp } from '../app.js';

afterEach(() => vi.unstubAllEnvs());

// Adapted from pinned tests/agent_server/test_managed_llm_key_http.py.
async function provider() {
  const control = {
    refreshStatus: 200, refreshKey: 'fixture-fresh-key', rejectFresh: false,
    completionStatus: 401, redirectRefresh: false, redirectHits: 0, finish: false,
    requests: [] as string[], refreshHeaders: [] as string[],
    refreshStarted: Promise.withResolvers<void>(), releaseRefresh: Promise.withResolvers<void>(),
    blockRefresh: false,
  };
  const server = createServer((request, response) => { void handle(request, response); });
  const reply = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.url === '/redirect-target') { control.redirectHits++; reply(response, 200, control.refreshKey); return; }
    if (request.method === 'GET' && request.url === '/current-key') {
      control.refreshHeaders.push(String(request.headers['x-session-api-key'] ?? ''));
      control.refreshStarted.resolve();
      if (control.blockRefresh) await control.releaseRefresh.promise;
      if (control.redirectRefresh) { response.writeHead(302, { location: '/redirect-target' }); response.end(); return; }
      reply(response, control.refreshStatus, control.refreshKey); return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { reply(response, 404, 'missing'); return; }
    for await (const chunk of request) { void chunk; /* Drain request body before replying. */ }
    const key = String(request.headers.authorization ?? '');
    control.requests.push(key);
    if (key !== 'Bearer fixture-fresh-key' || control.rejectFresh) {
      reply(response, control.completionStatus, { error: { message: 'fixture-private-provider-detail' } }); return;
    }
    reply(response, 200, { id: 'resumed', model: 'gpt-4o', choices: [{ message: { role: 'assistant', content: control.finish ? null : 'resumed',
      ...(control.finish ? { tool_calls: [{ id: 'finish-call', type: 'function', function: { name: 'finish', arguments: '{"message":"done"}' } }] } : {}),
    } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test provider address unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const env = { OH_LLM_API_KEY_REFRESH_URL: base + '/current-key', OH_LLM_API_KEY_REFRESH_BASE_URLS: base + '/v1', OH_LLM_API_KEY_REFRESH_HEADERS: '{"X-Session-API-Key":"${TEST_SESSION}"}', TEST_SESSION: 'fixture-session' };
  const profile = llmProfileSchema.parse({ profileId: 'managed', providerId: 'openai', model: 'gpt-4o', baseUrl: base + '/v1' });
  const store = new InMemorySecretStore([[llmProviderSecretRef('openai'), 'fixture-stale-key']]);
  const client = await createClientFromProfile(profile, store, { apiKeyRefreshHook: createManagedLlmKeyRefreshHook(profile, { env })!, retry: { maxAttempts: 1 } });
  return { control, env, profile, store, client, close: async () => {
    control.releaseRefresh.resolve();
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
  } };
}

it.each(['success', 'unavailable', 'empty', 'same', 'rejected', 'redirect'] as const)('recovers once over real HTTP: %s', async outcome => {
  const fixture = await provider();
  const { control, client, profile, store } = fixture;
  if (outcome === 'unavailable') control.refreshStatus = 503;
  if (outcome === 'empty') control.refreshKey = ' \n';
  if (outcome === 'same') control.refreshKey = 'fixture-stale-key';
  if (outcome === 'rejected') control.rejectFresh = true;
  if (outcome === 'redirect') control.redirectRefresh = true;
  try {
    if (outcome === 'success') expect((await client.complete([])).message.content).toMatchObject([{ text: 'resumed' }]);
    else {
      const error: unknown = await client.complete([]).catch(error => error);
      expect(error).toMatchObject({ name: 'LLMAuthenticationError' });
      expect(String(error)).not.toMatch(/fixture-private|fixture-stale|fixture-fresh/);
    }
    expect(control.requests).toEqual(outcome === 'success' || outcome === 'rejected' ? ['Bearer fixture-stale-key', 'Bearer fixture-fresh-key'] : ['Bearer fixture-stale-key']);
    expect(control.refreshHeaders).toEqual(['fixture-session']);
    expect(control.redirectHits).toBe(0);
    expect(JSON.stringify(profile)).not.toMatch(/fixture-stale|fixture-fresh|fixture-session/);
    expect(await store.get(llmProviderSecretRef('openai'))).toBe('fixture-stale-key');
  } finally { await fixture.close(); }
});

it('recovers overlapping completions independently while refresh yields the event loop', async () => {
  const fixture = await provider();
  fixture.control.blockRefresh = true;
  const pending = Promise.all(Array.from({ length: 4 }, () => fixture.client.complete([])));
  try {
    await fixture.control.refreshStarted.promise;
    let completed = false;
    void pending.then(() => { completed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    fixture.control.releaseRefresh.resolve();
    expect(await pending).toHaveLength(4);
    expect(fixture.control.requests.filter(key => key === 'Bearer fixture-stale-key')).toHaveLength(4);
    expect(fixture.control.requests.filter(key => key === 'Bearer fixture-fresh-key')).toHaveLength(4);
    expect(fixture.control.refreshHeaders).toEqual(Array(4).fill('fixture-session'));
  } finally { fixture.control.releaseRefresh.resolve(); await pending.catch(() => undefined); await fixture.close(); }
});

it('does not refresh an unrelated provider failure', async () => {
  const fixture = await provider();
  fixture.control.completionStatus = 500;
  try {
    await expect(fixture.client.complete([])).rejects.toMatchObject({ name: 'LLMHttpError' });
    expect(fixture.control.requests).toHaveLength(1);
    expect(fixture.control.refreshHeaders).toHaveLength(0);
  } finally { await fixture.close(); }
});

it('default server factory recovers preflight and main calls across restart without persisting credentials', async () => {
  const fixture = await provider();
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-key-server-'));
  for (const [name, value] of Object.entries(fixture.env)) vi.stubEnv(name, value);
  const options = { secretStore: fixture.store, config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root } };
  let server = await createAgentServerApp(options);
  try {
    const validated = await server.app.inject({ method: 'POST', url: '/api/profiles/managed/validate', payload: { llm: fixture.profile } });
    expect(validated.json()).toEqual({ valid: true, error: null });
    expect((await server.app.inject({ method: 'POST', url: '/api/profiles/managed', payload: fixture.profile })).statusCode).toBe(201);
    fixture.control.finish = true;
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { llm_profile_ref: 'managed', tools: ['finish'], condenser: { enabled: false } }, workspace: { working_dir: root } } });
    expect(started.statusCode).toBe(201);
    const id = started.json<{ id: string }>().id;
    async function run() {
      expect((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Finish', run: true } })).statusCode).toBe(200);
      await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe('finished');
    }
    await run();
    await server.app.close();
    server = await createAgentServerApp(options);
    await run();
    await server.app.close();
    expect(fixture.control.requests).toEqual(Array(3).fill(['Bearer fixture-stale-key', 'Bearer fixture-fresh-key']).flat());
    expect(fixture.control.refreshHeaders).toEqual(Array(3).fill('fixture-session'));
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
      const saved = await readFile(path.join(entry.parentPath, entry.name), 'utf8');
      expect(saved).not.toMatch(/fixture-stale-key|fixture-fresh-key|fixture-session|fixture-private-provider-detail/);
    }
  } finally { await server.app.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);
