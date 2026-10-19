import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, InMemorySecretStore, llmProfileSchema, messageSchema } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { createAgentServerApp, type AgentServerApp } from '../app.js';
import { PubSub } from '../pubSub.js';
const roots: string[] = [], servers: AgentServerApp[] = [];
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(complete: (id: string) => Promise<void>, options: { initialize?: boolean; prepare?: () => Promise<void> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'admission-cancel-')); roots.push(root);
  const calls: string[] = [];
  const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(), initializeOnCreate: options.initialize ?? false,
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, maxConcurrentRuns: 1 },
    agentFactory: async (_settings, context) => {
      await options.prepare?.();
      return new Agent({ llm: { profile: llmProfileSchema.parse({ profileId: 'fixture', providerId: 'openai', model: 'fixture' }),
        complete: async () => { calls.push(context.stored.id); await complete(context.stored.id); return { message: messageSchema.parse({ role: 'assistant', content: 'done' }), usage: null }; } } });
    },
  }); servers.push(server);
  const create = (payload: Record<string, unknown> = {}) => server.app.inject({ method: 'POST', url: '/api/conversations', payload });
  const send = (id: string) => server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Next request', run: true } });
  const idle = async (id: string) => (await server.conversationService.getEventService(id))!.whenIdle();
  return { server, calls, create, send, idle };
}

test('initial-message execution shares the creation reservation until actual work completes', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async () => { entered.resolve(); await release.promise; }, { initialize: true });
  try {
    const id = randomUUID();
    const created = await f.create({ id, initial_message: { role: 'user', content: 'Start now', run: true } });
    expect(created.statusCode, created.body).toBe(201);
    await entered.promise;
    expect((await f.create()).statusCode).toBe(429);
    expect(f.calls).toEqual([id]);
    release.resolve(); await f.idle(id);
    expect((await f.create()).statusCode).toBe(201);
  } finally { release.resolve(); }
});

test.each(['pause', 'interrupt', 'close'] as const)('%s cancels accepted continuation waiting behind another conversation', async action => {
  const competitorEntered = deferred(), competitorRelease = deferred(), tailEntered = deferred(), tailRelease = deferred();
  let competitor = '';
  const f = await fixture(async id => { if (id === competitor) { competitorEntered.resolve(); await competitorRelease.promise; } });
  const first = (await f.create()).json<{ id: string }>().id;
  competitor = (await f.create()).json<{ id: string }>().id;
  const original = PubSub.prototype.publish; let block = true;
  vi.spyOn(PubSub.prototype, 'publish').mockImplementation(async function (event) {
    if (block && typeof event === 'object' && event !== null && 'kind' in event && event.kind === 'ConversationStateUpdateEvent') {
      block = false; tailEntered.resolve(); await tailRelease.promise;
    }
    return original.call(this, event);
  });
  try {
    expect((await f.send(first)).statusCode).toBe(200); await tailEntered.promise;
    expect((await f.send(competitor)).statusCode).toBe(200); await competitorEntered.promise;
    expect((await f.send(first)).statusCode).toBe(200); tailRelease.resolve();
    await new Promise(resolve => setImmediate(resolve));
    const service = (await f.server.conversationService.getEventService(first))!;
    await service[action](); await service.whenIdle();
    expect(f.calls).toEqual([first, competitor]);
    expect(service.events().filter(event => event.kind === 'MessageEvent' && event.source === 'user')).toHaveLength(2);
    expect((await f.create()).statusCode).toBe(429);
    competitorRelease.resolve(); await f.idle(competitor);
    expect((await f.create()).statusCode).toBe(201);
    expect(f.calls).toEqual([first, competitor]);
  } finally { tailRelease.resolve(); competitorRelease.resolve(); }
});

test('pause during factory preparation keeps the slot until preparation settles and suppresses the pending completion', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture(async () => undefined, { prepare: async () => { entered.resolve(); await release.promise; } });
  const id = (await f.create()).json<{ id: string }>().id;
  try {
    expect((await f.send(id)).statusCode).toBe(200); await entered.promise;
    const service = (await f.server.conversationService.getEventService(id))!;
    const paused = service.pause();
    expect((await f.create()).statusCode).toBe(429);
    release.resolve(); await paused; await service.whenIdle();
    expect(f.calls).toEqual([]);
    expect((await f.create()).statusCode).toBe(201);
  } finally { release.resolve(); }
});
