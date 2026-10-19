import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { afterEach, expect, it, vi } from 'vitest';
import { registerGitRoutes } from '../gitRouter.js';
import { ServerStateService } from '../serverState.js';
import { searchProviderRepositories } from '../gitProviderService.js';
import { createAgentServerApp } from '../app.js';
import { pythonCasefold } from '../gitCasefold.js';

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const repository = (name: string, id = 1) => ({ id, full_name: name, private: false, stargazers_count: id, pushed_at: '2026-09-29T12:00:00Z', default_branch: 'main' });
const response = (items: unknown[], next?: string) => Response.json(items, { headers: next === undefined ? {} : { link: `<https://untrusted.example/path?page=${next}>; rel="next"` } });

it('serves global discovery with a token and missing-token state without requiring a valid cursor', async () => {
  const resolveSecret = vi.fn(async () => null as string | null);
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([repository('OpenHands/software-agent-sdk', 123)]));
  const app = Fastify(); registerGitRoutes(app, { resolveSecret, fetch });
  try {
    const missing = await app.inject('/api/git/repositories/search?provider=github&page_id=invalid');
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ items: [], next_page_id: null, missing_token: true });
    expect(fetch).not.toHaveBeenCalled();
    resolveSecret.mockResolvedValue('fixture-token');
    const found = await app.inject('/api/git/repositories/search?provider=github');
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ items: [{ id: '123', git_provider: 'github', main_branch: 'main', is_public: true }], next_page_id: null, missing_token: false });
    expect((await app.inject('/api/conversations/example/git/repositories/search?provider=github')).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('validates provider/limit before secret access and preserves provider error statuses', async () => {
  const resolveSecret = vi.fn(async () => 'fixture-secret');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('secret-provider-payload', { status: 403 }));
  const app = Fastify(); registerGitRoutes(app, { resolveSecret, fetch });
  try {
    for (const query of ['', '?provider=other', '?provider=github&limit=0', '?provider=github&limit=101', '?provider=github&limit=1.5', '?provider=github&limit=3x']) expect((await app.inject(`/api/git/repositories/search${query}`)).statusCode).toBe(422);
    expect((await app.inject('/api/git/repositories/search?provider=gitlab')).statusCode).toBe(400);
    expect(resolveSecret).not.toHaveBeenCalled();
    const failed = await app.inject('/api/git/repositories/search?provider=github');
    expect(failed.statusCode).toBe(403); expect(failed.body).not.toMatch(/fixture-secret|secret-provider-payload/);
  } finally { await app.close(); }
});

it('maps repositories and requests fixed GitHub URLs, token precedence, and no redirects', async () => {
  const resolveSecret = vi.fn(async (name: string) => name === 'GH_TOKEN' ? 'selected-token' : '');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([repository('OpenHands/first', 123), { ...repository('OpenHands/private', 456), private: true, default_branch: 'trunk' }, {}], '3'));
  const result = await searchProviderRepositories({ provider: 'github', limit: 30, page_id: ' +٢:0 ' }, { resolveSecret, fetch });
  expect(resolveSecret.mock.calls.flat()).toEqual(['github_token', 'GITHUB_TOKEN', 'GH_TOKEN']);
  const [input, init] = fetch.mock.calls[0]!;
  const url = new URL(String(input));
  expect(url.origin + url.pathname).toBe('https://api.github.com/user/repos');
  expect(Object.fromEntries(url.searchParams)).toEqual({ page: '2', per_page: '100', sort: 'pushed', affiliation: 'owner,collaborator,organization_member' });
  expect(init).toMatchObject({ redirect: 'manual', headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer selected-token', 'X-GitHub-Api-Version': '2022-11-28' } });
  expect(result).toEqual({ items: [
    { id: '123', full_name: 'OpenHands/first', git_provider: 'github', is_public: true, stargazers_count: 123, pushed_at: '2026-09-29T12:00:00Z', main_branch: 'main' },
    { id: '456', full_name: 'OpenHands/private', git_provider: 'github', is_public: false, stargazers_count: 456, pushed_at: '2026-09-29T12:00:00Z', main_branch: 'trunk' },
    { id: '', full_name: '', git_provider: 'github', is_public: true, stargazers_count: null, pushed_at: null, main_branch: null },
  ], next_page_id: '3', missing_token: false });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('filters across pages using Python casefold, while empty and whitespace queries stay distinct', async () => {
  const resolveSecret = async () => 'fixture';
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response([repository('Other/repo')], '2')).mockResolvedValueOnce(response([repository('Org/Straße'), repository('Org/STRASSE'), repository('Org/miss')], '3'));
  expect((await searchProviderRepositories({ provider: 'github', query: 'strasse', limit: 2 }, { resolveSecret, fetch })).items.map(item => item.full_name)).toEqual(['Org/Straße', 'Org/STRASSE']);
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['api.github.com', 'api.github.com']);
  for (const query of [null, '']) {
    const onePage = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response([], '2'));
    expect(await searchProviderRepositories({ provider: 'github', query }, { resolveSecret, fetch: onePage })).toMatchObject({ next_page_id: '2' });
    expect(onePage).toHaveBeenCalledTimes(1);
  }
  const whitespace = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response([repository('no-space')], '2')).mockResolvedValueOnce(response([repository('has space')]));
  expect((await searchProviderRepositories({ provider: 'github', query: ' ' }, { resolveSecret, fetch: whitespace })).items.map(item => item.full_name)).toEqual(['has space']);
});

it('applies offsets after filtering and retains exact continuation when limit changes', async () => {
  const resolveSecret = async () => 'fixture';
  const repos = [repository('other'), ...Array.from({ length: 10 }, (_, index) => repository(`org/r${index}`, index))];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response(repos, '3'));
  const first = await searchProviderRepositories({ provider: 'github', query: 'org/r', limit: 4 }, { resolveSecret, fetch });
  expect(first.next_page_id).toBe('1:4');
  const second = await searchProviderRepositories({ provider: 'github', query: 'org/r', limit: 2, page_id: first.next_page_id }, { resolveSecret, fetch });
  expect(second.items.map(item => item.full_name)).toEqual(['org/r4', 'org/r5']); expect(second.next_page_id).toBe('1:6');
  const third = await searchProviderRepositories({ provider: 'github', query: 'org/r', limit: 2, page_id: '2:8' }, { resolveSecret, fetch });
  expect(third.items.map(item => item.full_name)).toEqual(['org/r8', 'org/r9']); expect(third.next_page_id).toBe('3');
});

it('rejects malformed cursors before fetch and repeated next pages without following remote URLs', async () => {
  const resolveSecret = async () => 'fixture';
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response([], '1'));
  for (const page_id of ['', 'no-page', '0', '-1', '1:-1', '1:2:3', '1: ', '1.2', '9007199254740992', '1__2']) {
    await expect(searchProviderRepositories({ provider: 'github', page_id }, { resolveSecret, fetch })).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(fetch).not.toHaveBeenCalled();
  await expect(searchProviderRepositories({ provider: 'github', query: 'match' }, { resolveSecret, fetch })).rejects.toMatchObject({ statusCode: 502 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([[401, 401], [403, 403], [404, 400], [429, 400], [500, 502], [302, 400]])('maps HTTP %i to %i without exposing provider payload', async (status, statusCode) => {
  await expect(searchProviderRepositories({ provider: 'github' }, { resolveSecret: async () => 'sentinel-token', fetch: async () => new Response('sentinel-token provider-details', { status }) })).rejects.toMatchObject({ statusCode, message: 'GitHub repository search failed' });
});

it('sanitizes keychain, transport, JSON and malformed response failures', async () => {
  const resolveSecret = async () => 'sentinel-token';
  await expect(searchProviderRepositories({ provider: 'github' }, { resolveSecret: async () => { throw new Error('sentinel-token'); } })).rejects.toMatchObject({ message: 'Could not read configured repository credentials', statusCode: 502 });
  const failures: (typeof globalThis.fetch)[] = [async () => { throw new Error('sentinel-token'); }, async () => new Response('sentinel-token'), async () => Response.json({ message: 'sentinel-token' }), async () => Response.json([null])];
  for (const fetch of failures) {
    try { await searchProviderRepositories({ provider: 'github' }, { resolveSecret, fetch }); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ statusCode: 502 }); expect(String(error)).not.toContain('sentinel-token'); }
  }
});

it.each(['fetch', 'body'])('bounds an unresponsive %s at 15 seconds and aborts owned transport', async phase => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    signal = init?.signal;
    if (phase === 'fetch') return new Promise<Response>(() => undefined);
    return new Response(new ReadableStream({ start() { /* deliberately never closes */ } }));
  };
  const pending = searchProviderRepositories({ provider: 'github' }, { resolveSecret: async () => 'fixture', fetch });
  const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504, message: 'GitHub repository search timed out' });
  await vi.advanceTimersByTimeAsync(15_000); await assertion;
  expect(signal?.aborted).toBe(true);
});

it('uses only registered secrets from the actual state instance and rejects orphan/revoked entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-secret-')); roots.push(root);
  const store = new InMemorySecretStore(); const state = new ServerStateService({ stateDir: root, secretStore: store });
  const ref = { service: 'openhands', account: 'agent-server-secret:github_token' };
  await store.set(ref, 'orphan'); expect(await state.resolveSecret('github_token')).toBeNull();
  await state.setSecret('github_token', 'registered'); expect(await state.resolveSecret('github_token')).toBe('registered');
  await state.deleteSecret('github_token'); await store.set(ref, 'leftover'); expect(await state.resolveSecret('github_token')).toBeNull();
  const restored = new ServerStateService({ stateDir: root, secretStore: store }); expect(await restored.resolveSecret('github_token')).toBeNull();
});

it('runs session authentication before state secrets and binds discovery to the injected state service', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-app-')); roots.push(root);
  const injectedStore = new InMemorySecretStore();
  const state = new ServerStateService({ stateDir: path.join(root, 'state'), secretStore: injectedStore });
  await state.setSecret('github_token', 'injected-state-token');
  const lookup = vi.spyOn(state, 'resolveSecret');
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response([repository('org/allowed')]));
  const unrelatedStore = new InMemorySecretStore();
  await unrelatedStore.set({ service: 'openhands', account: 'agent-server-secret:github_token' }, 'wrong-store-token');
  const { app } = await createAgentServerApp({ serverStateService: state, secretStore: unrelatedStore, gitProviderFetch: fetch,
    config: { sessionApiKey: 'session-fixture', statePath: path.join(root, 'unused'), conversationsPath: path.join(root, 'conversations'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root },
    agentFactory: () => { throw new Error('Git discovery must not create an agent'); },
  });
  try {
    const url = '/api/git/repositories/search?provider=github';
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { 'x-session-api-key': 'wrong' } })).statusCode).toBe(401);
    expect(lookup).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    const found = await app.inject({ url, headers: { 'x-session-api-key': 'session-fixture' } });
    expect(found.statusCode).toBe(200); expect(found.json()).toMatchObject({ items: [{ full_name: 'org/allowed' }] });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer injected-state-token');
    expect((await app.inject({ url: '/api/conversations/example/git/repositories/search?provider=github', headers: { 'x-session-api-key': 'session-fixture' } })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('uses the generated pinned Python casefold behavior for Unicode expansions and scripts', () => {
  for (const [input, expected] of [['Straße', 'strasse'], ['ΟΣς', 'οσσ'], ['ﬃ', 'ffi'], ['İ', 'i\u0307'], ['ꭰ', 'Ꭰ'], ['Ꭰ', 'Ꭰ']]) expect(pythonCasefold(input!)).toBe(expected);
});
