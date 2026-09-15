// Adapted from pinned Python tests/agent_server/test_llm_router.py.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentServerApp } from '../app.js';

const folders: string[] = [];
const apps: Awaited<ReturnType<typeof createAgentServerApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(({ app }) => app.close()));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
  vi.restoreAllMocks();
});
const credentials = { vendor: 'openai', access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: 4_102_444_800_000, isExpired: () => false };
function fakeAuth() {
  return {
    getCredentials: vi.fn(() => credentials),
    refreshIfNeeded: vi.fn(async () => credentials),
    startDeviceLogin: vi.fn(async () => ({ verification_url: 'https://auth.example/device', user_code: 'ABCD-EFGH', device_auth_id: 'provider-internal-id', interval: 7 })),
    pollDeviceLogin: vi.fn(async (_challenge: unknown, _options: unknown) => credentials as typeof credentials | null),
    saveCredentials: vi.fn(),
    logout: vi.fn(() => true),
  };
}
async function setup(auth = fakeAuth()) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'subscription-router-'));
  folders.push(folder);
  const result = await createAgentServerApp({ config: { conversationsPath: folder, statePath: path.join(folder, 'state') }, subscriptionAuth: auth });
  apps.push(result);
  return { app: result.app, auth };
}
const prefix = '/api/llm/subscription/openai';
async function start(app: Awaited<ReturnType<typeof setup>>['app']) {
  const result = await app.inject({ method: 'POST', url: `${prefix}/device/start` });
  expect(result.statusCode).toBe(200);
  return result.json<{ device_code: string }>().device_code;
}
function poll(app: Awaited<ReturnType<typeof setup>>['app'], device_code: string) {
  return app.inject({ method: 'POST', url: `${prefix}/device/poll`, payload: { device_code } });
}

describe('LLM subscription routes', () => {
  it('returns safe status and refreshes credentials', async () => {
    const { app, auth } = await setup();
    const response = await app.inject(`${prefix}/status`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ vendor: 'openai', connected: true, account_email: null, expires_at: credentials.expires_at });
    expect(auth.refreshIfNeeded).toHaveBeenCalledOnce();
    expect(response.body).not.toContain('secret');
    auth.refreshIfNeeded.mockRejectedValueOnce(new Error('refresh failed'));
    expect((await app.inject(`${prefix}/status`)).json().connected).toBe(false);
  });
  it('returns only an opaque poll token, then pending and connected without credentials', async () => {
    const { app, auth } = await setup();
    const response = await app.inject({ method: 'POST', url: `${prefix}/device/start` });
    expect(response.statusCode).toBe(200);
    const challenge = response.json();
    expect(challenge).toMatchObject({ user_code: 'ABCD-EFGH', verification_uri: 'https://auth.example/device', verification_uri_complete: null, interval_seconds: 7 });
    expect(response.body).not.toContain('provider-internal-id');
    auth.pollDeviceLogin.mockResolvedValueOnce(null);
    expect((await poll(app, challenge.device_code)).json().connected).toBe(false);
    const success = await poll(app, challenge.device_code);
    expect(success.json().connected).toBe(true);
    expect(success.body).not.toContain('secret');
    expect(auth.pollDeviceLogin).toHaveBeenCalledWith(expect.objectContaining({ device_auth_id: 'provider-internal-id' }), { persist: false });
    expect(auth.saveCredentials).toHaveBeenCalledOnce();
    expect((await poll(app, challenge.device_code)).statusCode).toBe(404);
  });
  it('retains the opaque token after transient provider failure and sanitizes errors', async () => {
    const { app, auth } = await setup();
    const token = await start(app);
    auth.pollDeviceLogin.mockRejectedValueOnce(new Error('provider echoed access-secret'));
    const failed = await poll(app, token);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain('access-secret');
    expect((await poll(app, token)).json().connected).toBe(true);
  });
  it('drops expired device logins and rejects invalid input', async () => {
    const { app } = await setup();
    const token = await start(app);
    vi.spyOn(Date, 'now').mockReturnValue(4_102_444_800_000);
    expect((await poll(app, token)).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `${prefix}/device/poll`, payload: {} })).statusCode).toBe(422);
  });
  it('fences in-flight provider polling when logout happens and prevents duplicate polling', async () => {
    const { app, auth } = await setup();
    let finish!: (value: typeof credentials) => void;
    let began!: () => void;
    const running = new Promise<void>((resolve) => { began = resolve; });
    auth.pollDeviceLogin.mockImplementationOnce(() => { began(); return new Promise((resolve) => { finish = resolve; }); });
    const token = await start(app);
    const first = poll(app, token).then((response) => response);
    await running;
    expect((await poll(app, token)).json().connected).toBe(false);
    expect(auth.pollDeviceLogin).toHaveBeenCalledOnce();
    expect((await app.inject({ method: 'POST', url: `${prefix}/logout` })).json().connected).toBe(false);
    finish(credentials);
    expect((await first).json().connected).toBe(false);
    expect(auth.saveCredentials).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledOnce();
    expect((await poll(app, token)).statusCode).toBe(404);
  });
  it('requires the server session key on subscription routes', async () => {
    const { app } = await setup();
    // Exercise a separately configured app, leaving real auth and files untouched.
    const secured = await createAgentServerApp({ agentFactory: async () => { throw new Error('unused'); }, config: { sessionApiKey: 'test-session', conversationsPath: folders[0], statePath: path.join(folders[0]!, 'secured') } });
    apps.push(secured);
    expect((await secured.app.inject(`${prefix}/status`)).statusCode).toBe(401);
    expect((await app.inject(`${prefix}/models`)).statusCode).toBe(200);
  });
  it('lists sorted provider/model catalogs and preserves verified upstream models', async () => {
    const { app } = await setup();
    const providers = (await app.inject('/api/llm/providers')).json().providers;
    expect(providers).toContain('openai');
    expect(providers).toContain('anthropic');
    expect(providers).toEqual([...providers].sort());
    const models = (await app.inject('/api/llm/models?provider=openai')).json().models;
    expect(models).toContain('gpt-5.6-sol');
    expect(models).toEqual([...new Set(models)].sort());
    expect((await app.inject('/api/llm/models?provider=unknown')).json()).toEqual({ models: [] });
    const verified = (await app.inject('/api/llm/models/verified')).json().models;
    expect(verified.anthropic).toContain('claude-opus-5');
    expect(verified.deepseek).toContain('deepseek-v4-flash');
    expect((await app.inject(`${prefix}/models`)).json().models).toContain('gpt-5.5');
  });
});
