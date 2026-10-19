import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemorySecretStore, MetaProfileStore, MetaProfileStoreTimeoutError, defaultAgentSettings } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentServerApp, type AgentServerApp } from '../app.js';

// PORT: tests/agent_server/test_meta_profiles_router.py at dcf401af.
const roots: string[] = [];
const servers: AgentServerApp[] = [];
const meta = { classifier_model: 'classifier', classes: [{ description: 'tests', model: 'careful' }] };
const headers = { 'x-session-api-key': 'meta-test' };
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => server.app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(store?: MetaProfileStore) {
  const root = await mkdtemp(path.join(tmpdir(), 'meta-http-')); roots.push(root);
  const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(),
    ...(store === undefined ? {} : { metaProfileStore: store }),
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
      bashEventsPath: path.join(root, 'bash'), workspaceRoot: root, sessionApiKey: 'meta-test' } });
  servers.push(server);
  return { ...server, root, request: (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
    server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) }) };
}

test('isolated store uses server statePath and routes retain authentication', async () => {
  vi.stubEnv('OH_PERSISTENCE_DIR', '/must-not-touch-private-state');
  const f = await fixture();
  expect((await f.request('GET', '/api/meta-profiles')).json()).toEqual({ meta_profiles: [], active_meta_profile: null });
  expect(f.serverStateService.metaProfileStore.baseDir).toBe(path.join(f.root, 'state', 'meta-profiles'));
  expect((await f.app.inject({ method: 'GET', url: '/api/meta-profiles' })).statusCode).toBe(401);
});

test('an injected SDK store is the authoritative HTTP store and conflicts are rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'injected-meta-')); roots.push(root);
  const store = new MetaProfileStore(path.join(root, 'injected'));
  const f = await fixture(store);
  expect(f.serverStateService.metaProfileStore).toBe(store);
  expect((await f.request('POST', '/api/meta-profiles/p', meta)).statusCode).toBe(201);
  expect(await store.load('p')).toMatchObject(meta);
  await expect(createAgentServerApp({ serverStateService: f.serverStateService,
    metaProfileStore: new MetaProfileStore(path.join(root, 'other')), secretStore: new InMemorySecretStore(),
  })).rejects.toThrow('must share the same store');
});

test('CRUD returns source wrappers/statuses, sorted summaries, overwrites and idempotent delete', async () => {
  const f = await fixture();
  for (const name of ['z', 'a']) expect((await f.request('POST', `/api/meta-profiles/${name}`, meta)).statusCode).toBe(201);
  expect((await f.request('POST', '/api/meta-profiles/a', { ...meta, classifier_model: 'updated' })).json()).toEqual({ name: 'a', message: "Meta-profile 'a' saved" });
  expect((await f.request('GET', '/api/meta-profiles/a')).json()).toEqual({ name: 'a', config: { ...meta, classifier_model: 'updated', prompt_template: null, model_table: null } });
  expect((await f.request('GET', '/api/meta-profiles')).json().meta_profiles).toEqual([
    { name: 'a', classifier_model: 'updated', num_classes: 1 }, { name: 'z', classifier_model: 'classifier', num_classes: 1 },
  ]);
  for (let index = 0; index < 2; index++) expect((await f.request('DELETE', '/api/meta-profiles/a')).json()).toEqual({ name: 'a', message: "Meta-profile 'a' deleted" });
  for (const suffix of ['', '/activate']) expect((await f.request(suffix ? 'POST' : 'GET', `/api/meta-profiles/missing${suffix}`)).statusCode).toBe(404);
});

test('original HTTP names and bodies validate before optional store suffix normalization', async () => {
  const f = await fixture();
  for (const name of ['..bad..', 'a'.repeat(65), 'a'.repeat(61) + '.json'])
    expect((await f.request('POST', `/api/meta-profiles/${name}`, meta)).statusCode).toBe(422);
  for (const body of [{ classes: [] }, { ...meta, prompt_template: 'missing placeholder' }, { ...meta, api_key: 'must-not-save' }])
    expect((await f.request('POST', '/api/meta-profiles/valid', body)).statusCode).toBe(422);
  expect((await f.request('POST', '/api/meta-profiles/valid.json', meta)).statusCode).toBe(201);
  expect((await f.request('GET', '/api/meta-profiles/valid')).statusCode).toBe(200);
});

test('activation wires nested settings, clearing retains inline, deleting active clears it', async () => {
  const f = await fixture();
  await f.request('POST', '/api/meta-profiles/balanced', meta);
  const before = await f.serverStateService.settings();
  expect((await f.request('POST', '/api/meta-profiles/balanced/activate')).json()).toEqual({ name: 'balanced', message: "Meta-profile 'balanced' activated" });
  expect(await f.serverStateService.settings()).toMatchObject({ active_profile_id: before.active_profile_id, active_meta_profile: 'balanced', agent_settings: { active_meta_profile: 'balanced', enable_classify_and_switch_llm_tool: true, meta_profile: meta } });
  await f.request('PATCH', '/api/settings', { active_meta_profile: null });
  expect(await f.serverStateService.settings()).toMatchObject({ active_meta_profile: null, agent_settings: { enable_classify_and_switch_llm_tool: false, meta_profile: meta } });
  await f.request('POST', '/api/meta-profiles/balanced/activate');
  await f.request('DELETE', '/api/meta-profiles/balanced');
  expect(await f.serverStateService.settings()).toMatchObject({ active_meta_profile: null, agent_settings: { active_meta_profile: null, enable_classify_and_switch_llm_tool: false, meta_profile: null } });
});

test('corrupt stored data is400; summaries skip it; unexpected IO stays500', async () => {
  const f = await fixture();
  await writeFile(path.join(f.serverStateService.metaProfileStore.baseDir, 'broken.json'), '{');
  expect((await f.request('GET', '/api/meta-profiles/broken')).statusCode).toBe(400);
  expect((await f.request('POST', '/api/meta-profiles/broken/activate')).statusCode).toBe(400);
  expect((await f.request('GET', '/api/meta-profiles')).json().meta_profiles).toEqual([]);
  vi.spyOn(f.serverStateService.metaProfileStore, 'load').mockRejectedValue(Object.assign(new Error('private IO path'), { code: 'EACCES' }));
  const response = await f.request('GET', '/api/meta-profiles/broken');
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain('private IO path');
});

test('save/delete lock timeouts are503 and leave active settings intact', async () => {
  const f = await fixture();
  await f.request('POST', '/api/meta-profiles/active', meta);
  await f.request('POST', '/api/meta-profiles/active/activate');
  for (const [operation, method] of [['save', 'POST'], ['delete', 'DELETE']] as const) {
    const mock = vi.spyOn(f.serverStateService.metaProfileStore, operation).mockRejectedValue(new MetaProfileStoreTimeoutError(0, new Error('private lock')));
    const response = await f.request(method, '/api/meta-profiles/active', method === 'POST' ? meta : undefined);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ detail: 'Meta-profile store is busy. Please retry.' });
    mock.mockRestore();
  }
  expect((await f.serverStateService.settings()).active_meta_profile).toBe('active');
});

test('a stale store lock maps to503 without removing it or changing settings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'locked-meta-')); roots.push(root);
  const store = new MetaProfileStore(root, { lockTimeoutSeconds: 0 });
  const f = await fixture(store);
  const contents = '999999999\n';
  await writeFile(path.join(root, '.meta-profiles.lock'), contents);
  expect((await f.request('POST', '/api/meta-profiles/blocked', meta)).statusCode).toBe(503);
  expect((await f.request('DELETE', '/api/meta-profiles/blocked')).statusCode).toBe(503);
  expect(await readFile(path.join(root, '.meta-profiles.lock'), 'utf8')).toBe(contents);
  expect((await f.serverStateService.settings()).active_meta_profile).toBeNull();
});

test('failed activation persistence keeps the previous in-memory facade and safe error detail', async () => {
  const f = await fixture();
  await f.request('POST', '/api/meta-profiles/p', meta);
  await f.serverStateService.settings();
  await mkdir(path.join(f.root, 'state', 'state.json'));
  const response = await f.request('POST', '/api/meta-profiles/p/activate');
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain(f.root);
  expect(await f.serverStateService.settings()).toMatchObject({ active_meta_profile: null, agent_settings: { active_meta_profile: null, enable_classify_and_switch_llm_tool: false } });
});

test('the50 profile limit is atomic under concurrent creates and allows overwrite', async () => {
  const f = await fixture();
  for (let index = 0; index < 49; index++) await f.serverStateService.metaProfileStore.save(`seed-${index}`, meta);
  const responses = await Promise.all(['one', 'two'].map(name => f.request('POST', `/api/meta-profiles/${name}`, meta)));
  expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
  expect(await f.serverStateService.metaProfileStore.list()).toHaveLength(50);
  expect((await f.request('POST', '/api/meta-profiles/seed-0', meta)).statusCode).toBe(201);
});

test('delete/activate/settings mutations share one queue and preserve unrelated state', async () => {
  const f = await fixture();
  await f.request('POST', '/api/meta-profiles/old', meta);
  await f.request('POST', '/api/meta-profiles/new', meta);
  await f.request('POST', '/api/meta-profiles/old/activate');
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const original = f.serverStateService.metaProfileStore.delete.bind(f.serverStateService.metaProfileStore);
  vi.spyOn(f.serverStateService.metaProfileStore, 'delete').mockImplementation(async name => { entered(); await barrier; return original(name); });
  const deleting = f.request('DELETE', '/api/meta-profiles/old');
  await started;
  const activate = f.request('POST', '/api/meta-profiles/new/activate');
  const settings = f.serverStateService.createMcpServer('svc', { command: 'test' });
  release();
  await Promise.all([deleting, activate, settings]);
  expect(await f.serverStateService.settings()).toMatchObject({ active_meta_profile: 'new', agent_settings: { active_meta_profile: 'new', enable_classify_and_switch_llm_tool: true, mcp_config: { svc: { command: 'test' } } } });
  expect(JSON.parse(await readFile(path.join(f.root, 'state', 'state.json'), 'utf8')).settings.active_meta_profile).toBe('new');
});

test('ACP activation remains clear and native inline profiles reject raw credentials', async () => {
  const f = await fixture();
  await f.request('POST', '/api/meta-profiles/p', meta);
  await f.request('PATCH', '/api/settings', { agent_settings: { agent_kind: 'acp' } });
  expect((await f.request('POST', '/api/meta-profiles/p/activate')).statusCode).toBe(200);
  expect((await f.serverStateService.settings()).active_meta_profile).toBeNull();
  expect((await f.request('PATCH', '/api/settings', { agent_settings: { ...defaultAgentSettings('default'), meta_profile_llms: { x: { profileId: 'x', providerId: 'openai', model: 'x', api_key: 'private' } } } })).statusCode).toBe(422);
});

test('same-name activate/delete race cannot leave a dangling active pointer', async () => {
  const f = await fixture();
  await f.request('POST', '/api/meta-profiles/p', meta);
  const [removed, activated] = await Promise.all([
    f.request('DELETE', '/api/meta-profiles/p'), f.request('POST', '/api/meta-profiles/p/activate'),
  ]);
  expect(removed.statusCode).toBe(200);
  expect([200, 404]).toContain(activated.statusCode);
  expect((await f.serverStateService.settings()).active_meta_profile).toBeNull();
  expect(await f.serverStateService.metaProfileStore.list()).toEqual([]);
});

test('OpenAPI exposes all five operations with matching name and settings schemas', async () => {
  const f = await fixture();
  const schema = (await f.app.inject({ method: 'GET', url: '/openapi.json' })).json();
  const detail = schema.paths['/api/meta-profiles/{name}'];
  expect(Object.keys(detail).sort()).toEqual(['delete', 'get', 'post']);
  expect(schema.paths['/api/meta-profiles'].get).toBeDefined();
  expect(schema.paths['/api/meta-profiles/{name}/activate'].post).toBeDefined();
  expect(detail.post.parameters[0]).toMatchObject({ name: 'name', in: 'path', required: true,
    schema: { minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' } });
  expect(detail.post.responses['201']).toBeDefined();
  expect(detail.post.responses['409']).toBeDefined();
  expect(schema.paths['/api/settings'].patch.requestBody.content['application/json'].schema.properties.active_meta_profile).toBeDefined();
});
