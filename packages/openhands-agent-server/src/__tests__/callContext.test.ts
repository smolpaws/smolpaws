import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  InMemorySecretStore, LLMContextWindowExceedError, getLLMCallContext, llmProfileSchema, messageSchema,
  type LLMCallContext, type LLMClient, type LLMCompletionResponse, type Message,
} from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';

// Adapted from pinned tests/sdk/conversation/local/test_call_context_isolation.py:
// shared-agent/async isolation, unchanged configured headers, and fresh fork context.
// test_conversation_id.py also requires the cache key to equal the conversation ID.
// These exercise the real server -> EventService -> LocalConversation binding.
const roots: string[] = [];
const servers: AgentServerApp[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve);
  return { promise, resolve };
}

interface Call {
  profileId: string;
  messages: readonly Message[];
  context: LLMCallContext | null | undefined;
  scopedBefore: LLMCallContext;
  scopedAfter?: LLMCallContext;
}

const answer = (content = 'Completed the task.'): LLMCompletionResponse => ({
  message: messageSchema.parse({ role: 'assistant', content }),
  usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
});

async function fixture(respond: (call: Call) => Promise<LLMCompletionResponse> = async () => answer()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'server-call-context-'));
  roots.push(root);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network in call-context test'));
  const calls: Call[] = [];
  // Returning one client per profile deliberately shares clients between conversations
  // and app instances, as the upstream shared-agent regression requires.
  const clients = new Map<string, LLMClient>();
  const options: AgentServerAppOptions = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
      workspaceRoot: root, bashEventsPath: path.join(root, 'bash') },
    secretStore: new InMemorySecretStore(),
    resolveCondenserProfileSelection: () => 'summary',
    llmClientFactory: async profile => {
      let client = clients.get(profile.profileId);
      if (client === undefined) {
        client = { profile, complete: async (messages, _tools, completionOptions) => {
          const call: Call = { profileId: profile.profileId, messages,
            context: completionOptions?.callContext, scopedBefore: getLLMCallContext() };
          calls.push(call);
          try { return await respond(call); }
          finally { call.scopedAfter = getLLMCallContext(); }
        } };
        clients.set(profile.profileId, client);
      }
      return client;
    },
  };
  const server = await createAgentServerApp(options);
  servers.push(server);
  for (const profileId of ['main', 'summary']) {
    await server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId, providerId: 'openai',
      model: `model-${profileId}`, headers: { 'X-Custom': 'keep-me' } }));
  }
  return { server, calls, clients, restart: async () => {
    await server.app.close();
    const restored = await createAgentServerApp(options);
    servers.push(restored);
    return restored;
  } };
}

async function start(server: AgentServerApp, agent: Record<string, unknown> = {}) {
  const response = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    agent: { llm_profile_ref: 'main', tools: ['finish'], condenser: { enabled: false }, ...agent },
  } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>().id;
}

async function send(server: AgentServerApp, id: string, content = 'Continue', run = true) {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`,
    payload: { role: 'user', content, run } });
  expect(response.statusCode, response.body).toBe(200);
}

async function settled(server: AgentServerApp, id: string) {
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe('finished');
  await (await server.conversationService.getEventService(id))!.whenIdle();
}

function expectContext(call: Call, id: string) {
  expect(call.context).toMatchObject({ sessionId: id, promptCacheKey: id });
  expect(call.scopedBefore).toBe(call.context);
  expect(call.scopedAfter).toBe(call.context);
}

test('overlapping conversations sharing one client each use their durable server identity', async () => {
  const release = gate();
  const f = await fixture(async () => { await release.promise; return answer(); });
  const firstId = await start(f.server);
  const secondId = await start(f.server);
  await Promise.all([send(f.server, firstId, 'First isolated task.'), send(f.server, secondId, 'Second isolated task.')]);
  await expect.poll(() => f.calls.length).toBe(2);
  release.resolve();
  await Promise.all([settled(f.server, firstId), settled(f.server, secondId)]);
  const first = f.calls.find(call => JSON.stringify(call.messages).includes('First isolated task.'))!;
  const second = f.calls.find(call => JSON.stringify(call.messages).includes('Second isolated task.'))!;
  expectContext(first, firstId);
  expectContext(second, secondId);
  expect(first.context).not.toBe(second.context);
  expect(f.clients.size).toBe(1);
  expect(f.clients.get('main')!.profile.headers).toEqual({ 'X-Custom': 'keep-me' });
  expect(getLLMCallContext()).toMatchObject({ sessionId: null, promptCacheKey: null });
});

test('disk restoration recreates context with the same durable conversation ID', async () => {
  const f = await fixture();
  const id = await start(f.server);
  await send(f.server, id); await settled(f.server, id);
  const restored = await f.restart();
  await send(restored, id, 'Continue after restart.'); await settled(restored, id);
  expect(f.calls).toHaveLength(2);
  for (const call of f.calls) expectContext(call, id);
  expect(f.calls[0]!.context).not.toBe(f.calls[1]!.context);
  expect(f.clients.size).toBe(1);
});

test('a fork receives its new server identity without changing the source context', async () => {
  const f = await fixture();
  const id = await start(f.server);
  await send(f.server, id); await settled(f.server, id);
  const response = await f.server.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, payload: {} });
  expect(response.statusCode, response.body).toBe(201);
  const forkId = response.json<{ id: string }>().id;
  expect(forkId).not.toBe(id);
  await send(f.server, forkId, 'Continue the fork.'); await settled(f.server, forkId);
  await send(f.server, id, 'Continue the source.'); await settled(f.server, id);
  expect(f.calls).toHaveLength(3);
  expectContext(f.calls[0]!, id);
  expectContext(f.calls[1]!, forkId);
  expectContext(f.calls[2]!, id);
  expect(f.calls[2]!.context).toBe(f.calls[0]!.context);
  expect(f.calls[1]!.context).not.toBe(f.calls[0]!.context);
});

test('manual summarization receives the owning conversation context on its independent client', async () => {
  const f = await fixture();
  const id = await start(f.server, { condenser: { llm_profile_ref: 'summary', max_size: 1000, keep_first: 0 } });
  await send(f.server, id, 'Completed work to summarize.'); await settled(f.server, id);
  await send(f.server, id, 'Another pending task.', false);
  const response = await f.server.app.inject({ method: 'POST', url: `/api/conversations/${id}/condense`, payload: {} });
  expect(response.statusCode, response.body).toBe(200);
  expect(f.calls.map(call => call.profileId)).toEqual(['main', 'summary']);
  for (const call of f.calls) expectContext(call, id);
  expect(f.calls[1]!.context).toBe(f.calls[0]!.context);
});

test('hard-overflow summarization and the retry retain the owning conversation context', async () => {
  let rejectOnce = false;
  const f = await fixture(async call => {
    if (call.profileId === 'main' && rejectOnce) {
      rejectOnce = false;
      throw new LLMContextWindowExceedError('Synthetic context limit');
    }
    return answer(call.profileId === 'summary' ? 'Summary of completed work.' : 'Completed the task.');
  });
  const id = await start(f.server, { condenser: { condenser_kind: 'agent_reset' },
    hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'summary', hard_context_reset_max_retries: 1 } });
  await send(f.server, id, 'Completed work to preserve.'); await settled(f.server, id);
  rejectOnce = true;
  await send(f.server, id, 'Pending task after overflow.'); await settled(f.server, id);
  expect(f.calls.map(call => call.profileId)).toEqual(['main', 'main', 'summary', 'main']);
  for (const call of f.calls) {
    expectContext(call, id);
    expect(call.context).toBe(f.calls[0]!.context);
  }
});
