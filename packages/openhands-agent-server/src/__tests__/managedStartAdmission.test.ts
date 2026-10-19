import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySecretStore, TestLLM, llmProfileSchema } from '@smolpaws/openhands-agent';
import { expect, test, vi } from 'vitest';
import { createAgentServerApp } from '../app.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const profile = llmProfileSchema.parse({ profileId: 'selected', providerId: 'openai', model: 'fixture' });
const payload = { id: '11111111-1111-4111-8111-111111111111', agent: { llm_profile_ref: 'selected', tools: [], condenser: { enabled: false } } };

test('managed same-ID retry reuses its captured profile after catalog deletion without re-preparation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-start-reuse-'));
  const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(),
    llmClientFactory: async () => TestLLM.fromMessages([]), config: { conversationsPath: root, workspaceRoot: root } });
  try {
    await server.serverStateService.saveProfile(profile);
    const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload });
    expect(created.statusCode, created.body).toBe(201);
    await server.serverStateService.deleteProfile('selected');
    const lookup = vi.spyOn(server.serverStateService, 'getProfile');
    const retried = await server.app.inject({ method: 'POST', url: '/api/conversations', payload });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ id: payload.id, agent: { llm_profile_ref: 'selected' } });
    expect(lookup).not.toHaveBeenCalled();
  } finally { await server.app.close(); await rm(root, { recursive: true, force: true }); }
});

test('managed overload rejects before profile resolution and failed preparation releases admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-start-capacity-'));
  const entered = deferred(), release = deferred();
  const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(), maxConcurrentRuns: 1,
    llmClientFactory: async () => TestLLM.fromMessages([]),
    configureContext: async (context) => { entered.resolve(); await release.promise; return context; },
    config: { conversationsPath: root, workspaceRoot: root } });
  try {
    await server.serverStateService.saveProfile(profile);
    const creating = server.app.inject({ method: 'POST', url: '/api/conversations', payload }).then(result => result);
    await entered.promise;
    const lookup = vi.spyOn(server.serverStateService, 'getProfile');
    const missing = { agent: { llm_profile_ref: 'missing', tools: [], condenser: { enabled: false } } };
    const rejected = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: missing });
    expect(rejected.statusCode, rejected.body).toBe(429);
    expect(lookup).not.toHaveBeenCalled();
    release.resolve();
    expect((await creating).statusCode).toBe(201);
    expect((await server.app.inject({ method: 'POST', url: '/api/conversations', payload: missing })).statusCode).toBe(422);
    const afterFailure = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: payload.agent } });
    expect(afterFailure.statusCode, afterFailure.body).toBe(201);
  } finally { release.resolve(); await server.app.close(); await rm(root, { recursive: true, force: true }); }
});
