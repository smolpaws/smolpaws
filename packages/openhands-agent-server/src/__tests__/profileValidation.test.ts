import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySecretStore, messageSchema, type Message } from '@smolpaws/openhands-agent';
import { expect, it, vi } from 'vitest';
import { createAgentServerApp } from '../app.js';

// PORT: d77ada7a system-first profile preflight. The legacy two-argument factory remains valid.
it('preflights with exactly the system instruction then user ping and does not save the profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-preflight-'));
  const complete = vi.fn(async (_messages: readonly Message[]) => ({ message: messageSchema.parse({ role: 'assistant', content: 'ok' }) }));
  const store = new InMemorySecretStore();
  const factory = vi.fn(async (profile, secretStore) => { expect(secretStore).toBe(store); return { profile, complete }; });
  const server = await createAgentServerApp({ secretStore: store, llmClientFactory: factory, config: { statePath: path.join(root, 'state'), conversationsPath: path.join(root, 'conversations'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root } });
  try {
    const before = (await server.app.inject('/api/profiles')).json();
    const result = await server.app.inject({ method: 'POST', url: '/api/profiles/test/validate', payload: { llm: { profileId: 'test', providerId: 'openai', model: 'gpt-4o' } } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ valid: true, error: null });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0]).toEqual([
      messageSchema.parse({ role: 'system', content: 'Reply with one token.' }),
      messageSchema.parse({ role: 'user', content: 'ping' }),
    ]);
    expect((await server.app.inject('/api/profiles')).json()).toEqual(before);
    expect((await server.app.inject('/api/profiles/test')).statusCode).toBe(404);
  } finally { await server.app.close(); await rm(root, { recursive: true, force: true }); }
});
