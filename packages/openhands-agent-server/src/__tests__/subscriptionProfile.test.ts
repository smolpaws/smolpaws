// Regression for upstream 3896f186: subscription preflight must restore credentials.
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore, OAuthCredentials, OpenAISubscriptionAuth, InMemorySecretStore } from '@smolpaws/openhands-agent';
import { expect, it, vi } from 'vitest';
import { createAgentServerApp } from '../app.js';

it('uses SDK subscription auth for preflight, execution and persisted conversation resume without API keys', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-subscription-profile-'));
  const store = new CredentialStore(path.join(root, 'auth'));
  store.save(new OAuthCredentials({ vendor: 'openai', access_token: 'old-private-access', refresh_token: 'private-refresh', expires_at: 0 }));
  const authFetch = vi.fn(async () => new Response(JSON.stringify({ access_token: 'new-private-access', refresh_token: 'new-private-refresh', expires_in: 3600 }), { status: 200 }));
  const auth = new OpenAISubscriptionAuth({ credentialStore: store, fetch: authFetch });
  const bodies: Record<string, unknown>[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-private-access');
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    const output = bodies.length === 1
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'valid' }] }]
      : [{ type: 'function_call', id: `fc-${bodies.length}`, call_id: `call-${bodies.length}`, name: 'finish', arguments: JSON.stringify({ message: `done-${bodies.length}` }) }];
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const options = { subscriptionAuth: auth, secretStore: new InMemorySecretStore(), config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root } };
  let server = await createAgentServerApp(options);
  const profile = { profileId: 'chatgpt-test', providerId: 'openai', model: 'gpt-5.5', authType: 'subscription', subscriptionVendor: 'openai' };
  try {
    const validation = await server.app.inject({ method: 'POST', url: '/api/profiles/chatgpt-test/validate', payload: { llm: profile } });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toEqual({ valid: true, error: null });
    expect(authFetch).toHaveBeenCalledOnce();
    expect((await server.app.inject({ method: 'POST', url: '/api/profiles/chatgpt-test', payload: profile })).statusCode).toBe(201);
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { llm_profile_ref: 'chatgpt-test', tools: ['finish'], condenser: { enabled: false } }, workspace: { working_dir: root }, initial_message: { role: 'user', content: 'Finish first turn', run: false } } });
    expect(started.statusCode).toBe(201);
    const id = started.json().id;
    await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
    await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status, { timeout: 10_000 }).toBe('finished');
    await server.app.close();
    server = await createAgentServerApp({ ...options, subscriptionAuth: new OpenAISubscriptionAuth({ credentialStore: new CredentialStore(path.join(root, 'auth')), fetch: authFetch }) });
    expect((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Finish the continuation', run: false } })).statusCode).toBe(200);
    await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
    await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status, { timeout: 10_000 }).toBe('finished');
    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[2]?.input)).toContain('Finish first turn');
    expect(JSON.stringify(bodies[2]?.input)).toContain('Finish the continuation');
    expect(authFetch).toHaveBeenCalledOnce();
    for (const folder of [options.config.conversationsPath, options.config.statePath]) {
      for (const filename of await readdir(folder, { recursive: true })) {
        try {
          const text = await readFile(path.join(folder, filename), 'utf8');
          expect(text).not.toContain('private-access');
          expect(text).not.toContain('private-refresh');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
        }
      }
    }
  } finally {
    await server.app.close();
    fetchSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);


it('reports missing subscription login without making an API-key or provider request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-subscription-missing-'));
  const providerFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
  const authFetch = vi.fn(async () => { throw new Error('No OAuth network expected'); });
  const secretStore = new InMemorySecretStore();
  const getSecret = vi.spyOn(secretStore, 'get');
  const server = await createAgentServerApp({ secretStore, subscriptionAuth: new OpenAISubscriptionAuth({ credentialStore: new CredentialStore(path.join(root, 'auth')), fetch: authFetch }), config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state') } });
  try {
    const result = await server.app.inject({ method: 'POST', url: '/api/profiles/missing/validate', payload: { llm: { profileId: 'missing', providerId: 'openai', model: 'gpt-5.5', authType: 'subscription', subscriptionVendor: 'openai' } } });
    expect(result.statusCode).toBe(200);
    expect(result.json().valid).toBe(false);
    expect(result.json().error.message).toMatch(/login|connect|authenticat/i);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(authFetch).not.toHaveBeenCalled();
    expect(getSecret).not.toHaveBeenCalled();
  } finally {
    await server.app.close();
    providerFetch.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
