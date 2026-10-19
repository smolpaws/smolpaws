import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, LLMCallContext, MetaProfileStore, ToolDefinition, createClientFromProfile, llmProfileSchema, llmProfileSecretRef, llmProviderSecretRef, messageSchema, type LLMProfile } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';
import { createProfileAgentFactory } from '../profileAgentFactory.js';

// Adapted from pinned test_classify_and_switch_llm.py: inline cloud profiles,
// authoritative named store, one classifier usage bucket and conversation context.
// Server tests additionally exercise its durable, completed-step selection boundary.
const roots: string[] = [];
const servers: AgentServerApp[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const profile = (profileId: string, model = `model-${profileId}`) => llmProfileSchema.parse({ profileId, model, providerId: 'openai' });
const reply = (text: string) => messageSchema.parse({ role: 'assistant', content: text });
const route = (...siblings: string[]) => messageSchema.parse({ role: 'assistant', content: [], tool_calls: ['route_task_to_model', ...siblings].map((name, index) => ({
  id: `route-${randomUUID()}-${index}`, name, arguments: name === 'think' ? '{"thought":"Wait"}' : name === 'finish' ? '{"message":"Done"}' : '{}', origin: 'completion',
})) });
const meta = { classifier_model: 'classifier', classes: [{ description: 'implementation', model: 'target' }] };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(input: {
  agent?: Record<string, unknown>;
  extra?: Partial<AgentServerAppOptions>;
  siblings?: string[];
  saved?: string[];
  classifierReply?: string;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meta-routing-')); roots.push(root);
  const calls: Array<{ name: string; context: LLMCallContext | null | undefined }> = [];
  const built: LLMProfile[] = [];
  let routeNext = true;
  const options: AgentServerAppOptions = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, bashEventsPath: path.join(root, 'bash') },
    secretStore: new InMemorySecretStore(),
    errorLogger: { error: vi.fn() },
    llmClientFactory: async selected => {
      built.push(selected);
      return { profile: selected, complete: async (_messages, _tools, completionOptions) => {
        calls.push({ name: selected.profileId, context: completionOptions?.callContext });
        const message = selected.profileId === 'classifier' ? reply(input.classifierReply ?? '1')
          : routeNext ? (routeNext = false, route(...input.siblings ?? [])) : reply('Completed');
        return { message, usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } };
      } };
    },
    ...input.extra,
  };
  const server = await createAgentServerApp(options); servers.push(server);
  for (const name of input.saved ?? ['main', 'classifier', 'target', 'other']) await server.serverStateService.saveProfile(profile(name));
  const store = new MetaProfileStore(path.join(root, 'state', 'meta-profiles'));
  await store.save('routing', meta);
  const start = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    max_iterations: 4,
    agent: { llm_profile_ref: 'main', condenser: { enabled: false }, tools: ['finish', 'think'], tool_concurrency_limit: 2,
      enable_classify_and_switch_llm_tool: true, active_meta_profile: 'routing', meta_profile: meta, ...input.agent },
  } });
  expect(start.statusCode, start.body).toBe(201);
  const id = start.json<{ id: string }>().id;
  return { root, server, id, calls, built, store, options, routeAgain: () => { routeNext = true; },
    metadata: async () => JSON.parse(await readFile(path.join(root, 'conversations', id, 'meta.json'), 'utf8')),
  };
}
async function send(server: AgentServerApp, id: string) {
  expect((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Implement this', run: true } })).statusCode).toBe(200);
}
async function settle(server: AgentServerApp, id: string, status = 'finished') {
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe(status);
  await (await server.conversationService.getEventService(id))!.whenIdle();
}

test('routing uses the shared named store, records classifier usage once, and shares durable call context', async () => {
  const f = await fixture();
  await f.store.save('routing', { ...meta, classes: [{ description: 'latest', model: 'other' }] });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'other']);
  expect(f.calls.every(call => call.context?.sessionId === f.id && call.context?.promptCacheKey === f.id)).toBe(true);
  const service = (await f.server.conversationService.getEventService(f.id))!;
  expect(service.state.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(1);
  expect(service.events().filter(event => event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage')).toHaveLength(3);
  const metadata = await f.metadata();
  expect(metadata.request.agent.llm_profile_ref).toBe('other');
  expect(metadata.request.llm_profile_selection.pending_profile).toBeNull();
  expect(metadata.request.llm_profile_snapshot.profileId).toBe('other');
  await f.store.save('routing', meta);
  f.routeAgain();
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'other', 'other', 'classifier', 'target']);
  expect(service.state.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(2);
  expect(f.built.filter(item => item.profileId === 'classifier')).toHaveLength(1);
});

test('direct factory calls inherit the state store instead of the SDK environment default', async () => {
  const f = await fixture();
  vi.stubEnv('OH_PERSISTENCE_DIR', path.join(f.root, 'unrelated-sdk-state'));
  await f.store.save('routing', { ...meta, classes: [{ description: 'state-owned', model: 'other' }] });
  const service = (await f.server.conversationService.getEventService(f.id))!;
  const switchProfile = vi.fn(async () => ({ model: 'selected' }));
  const factory = createProfileAgentFactory({ state: f.server.serverStateService, secretStore: new InMemorySecretStore(),
    llmClientFactory: async selected => ({ profile: selected, complete: async () => ({ message: reply('1'), usage: null }) }),
  });
  const agent = await factory(service.stored.request.agent, { stored: service.stored, state: service.state,
    switchProfile, getLLMCallContext: () => LLMCallContext.forConversation(f.id) });
  const tool = agent.tools.find(item => item.name === 'route_task_to_model')!;
  await tool.execute({});
  expect(switchProfile).toHaveBeenCalledWith('other', undefined);
});

test.each(['route_task_to_model', 'ClassifyAndSwitchLLMTool'])('explicit %s plus enabled setting attaches exactly once before host composition', async alias => {
  const configureTools = vi.fn<NonNullable<AgentServerAppOptions['configureTools']>>(tools => tools);
  const f = await fixture({ agent: { tools: [alias, 'route_task_to_model', 'finish'] }, extra: { configureTools } });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(configureTools).toHaveBeenCalledOnce();
  expect(configureTools.mock.calls[0]![0].filter(tool => tool.name === 'route_task_to_model')).toHaveLength(1);
});

test.each(['route_task_to_model', 'ClassifyAndSwitchLLMTool'])('explicit %s parameters override settings and bare aliases', async alias => {
  const f = await fixture({ agent: { enable_classify_and_switch_llm_tool: false,
    tools: ['route_task_to_model', { name: alias, params: { active_meta_profile: 'chosen' } },
      { name: 'ClassifyAndSwitchLLMTool', params: { active_meta_profile: 'chosen' } }, 'finish'] } });
  await f.store.save('chosen', { ...meta, classes: [{ description: 'explicit', model: 'other' }] });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'other']);
});

test('enabled settings override explicit router params including null selection and inline config', async () => {
  const f = await fixture({ agent: { tools: [{ name: 'route_task_to_model', params: {
    active_meta_profile: null, meta_profile: { ...meta, classes: [{ description: 'inline', model: 'other' }] },
  } }, 'finish'] } });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'target']);
});

test.each([
  [{ name: 'route_task_to_model', params: { api_key: 'must-never-persist' } }],
  [{ name: 'route_task_to_model', params: { meta_profile_llms: { bad: { ...profile('bad'), api_key: 'must-never-persist' } } } }],
  ['route_task_to_model', { name: 'ClassifyAndSwitchLLMTool', params: { api_key: 'must-never-persist' } }],
].map(tools => ({ tools })))('unsafe routing specs are rejected before conversation persistence ($tools)', async ({ tools }) => {
  const f = await fixture();
  const directory = path.join(f.root, 'conversations');
  const before = await readdir(directory);
  const response = await f.server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    agent: { llm_profile_ref: 'main', condenser: { enabled: false }, tools },
  } });
  expect(response.statusCode).toBe(422);
  expect(response.body).not.toContain('must-never-persist');
  expect(await readdir(directory)).toEqual(before);
});

test('selection is durable during the current step and activates only after all sibling tools settle', async () => {
  const entered = deferred(); const gate = deferred();
  const configureTools = vi.fn<NonNullable<AgentServerAppOptions['configureTools']>>(tools => tools.map(tool => tool.name !== 'think' ? tool : new ToolDefinition({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    executor: async () => { entered.resolve(); await gate.promise; return { thought: 'settled' }; },
  })));
  const f = await fixture({ siblings: ['think'], extra: { configureTools } });
  try {
    await send(f.server, f.id);
    await entered.promise;
    await expect.poll(async () => (await f.metadata()).request.llm_profile_selection?.pending_profile?.profileId).toBe('target');
    expect((await f.metadata()).request.agent.llm_profile_ref).toBe('main');
    expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier']);
  } finally { gate.resolve(); }
  await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'target']);
  expect(configureTools).toHaveBeenCalledOnce();
});

test('inline profiles bind map names to safe snapshots and survive finish, restore and fork without catalog records', async () => {
  const f = await fixture({ saved: ['main'], siblings: ['finish'], agent: {
    meta_profile_llms: { classifier: { ...profile('wrong-classifier'), useProfileKeyOverride: true }, target: { ...profile('wrong-target'), useProfileKeyOverride: true } },
  } });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier']);
  const stored = (await f.metadata()).request;
  expect(stored.agent.llm_profile_ref).toBe('target');
  expect(stored.llm_profile_snapshot).toMatchObject({ profileId: 'target', useProfileKeyOverride: true });
  expect(stored.llm_profile_snapshot).not.toHaveProperty('apiKey');
  const fork = await f.server.app.inject({ method: 'POST', url: `/api/conversations/${f.id}/fork`, payload: {} });
  expect(fork.statusCode).toBe(201);
  const forkId = fork.json<{ id: string }>().id;
  await f.server.app.close();
  const restarted = await createAgentServerApp(f.options); servers.push(restarted);
  for (const id of [f.id, forkId]) { await send(restarted, id); await settle(restarted, id); }
  expect(f.calls.slice(-2).map(call => call.name)).toEqual(['target', 'target']);
  expect(f.calls.slice(-2).map(call => call.context?.sessionId)).toEqual([f.id, forkId]);
});

test('removing the active meta profile after preparation retains its captured inline fallback', async () => {
  const f = await fixture({ agent: { meta_profile: null } });
  await f.store.delete('routing');
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'target']);
  expect((await f.metadata()).request.agent.llm_profile_ref).toBe('target');
});

test('disabled routing never attaches the tool or resolves its missing classifier', async () => {
  const configureTools = vi.fn<NonNullable<AgentServerAppOptions['configureTools']>>(tools => tools);
  const f = await fixture({ saved: ['main'], agent: { enable_classify_and_switch_llm_tool: false }, extra: { configureTools } });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(configureTools.mock.calls[0]![0].some(tool => tool.name === 'route_task_to_model')).toBe(false);
  expect(f.built.map(item => item.profileId)).toEqual(['main']);
});

test('invalid reply keeps the active profile while recording the paid classification', async () => {
  const f = await fixture({ classifierReply: 'no applicable category' });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'main']);
  expect((await f.metadata()).request.agent.llm_profile_ref).toBe('main');
  expect((await f.server.conversationService.getEventService(f.id))!.state.stats.usage_to_metrics['classifier:classifier']?.records).toHaveLength(1);
});

test('removing a routed LLM after preparation preserves the resolved secret-reference snapshot', async () => {
  const f = await fixture();
  await f.server.serverStateService.deleteProfile('target');
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier', 'target']);
  expect((await f.metadata()).request.llm_profile_snapshot).toMatchObject({ profileId: 'target', model: 'model-target' });
});

test('inline names select their own SecretStore overrides through the real shared client factory', async () => {
  const secretStore = new InMemorySecretStore();
  await secretStore.set(llmProviderSecretRef('openai'), 'fixture-main-key');
  await secretStore.set(llmProfileSecretRef('classifier'), 'fixture-classifier-key');
  await secretStore.set(llmProfileSecretRef('target'), 'fixture-target-key');
  const requests: Array<{ authorization: string | null; session: string | null; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ authorization: headers.get('authorization'), session: headers.get('x-litellm-session-id'), body });
    const message = requests.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'route', type: 'function', function: { name: 'route_task_to_model', arguments: '{}' } }] }
      : { role: 'assistant', content: requests.length === 2 ? '1' : 'Complete' };
    return new Response(JSON.stringify({ id: `completion-${requests.length}`, choices: [{ message }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { headers: { 'content-type': 'application/json' } });
  });
  const f = await fixture({ saved: ['main'], extra: { secretStore, llmClientFactory: createClientFromProfile }, agent: {
    meta_profile_llms: {
      classifier: { ...profile('wrong-classifier'), useProfileKeyOverride: true, supportsPromptCacheKey: true },
      target: { ...profile('wrong-target'), useProfileKeyOverride: true, supportsPromptCacheKey: true },
    },
  } });
  await send(f.server, f.id); await settle(f.server, f.id);
  expect(requests.map(request => request.authorization)).toEqual(['Bearer fixture-main-key', 'Bearer fixture-classifier-key', 'Bearer fixture-target-key']);
  expect(requests.map(request => request.session)).toEqual([f.id, f.id, f.id]);
  expect(requests.slice(1).map(request => request.body.prompt_cache_key)).toEqual([f.id, f.id]);
  const metadata = JSON.stringify(await f.metadata());
  const events = JSON.stringify((await f.server.conversationService.getEventService(f.id))!.events());
  for (const key of ['fixture-main-key', 'fixture-classifier-key', 'fixture-target-key']) {
    expect(metadata).not.toContain(key); expect(events).not.toContain(key);
  }
});

test('classifier accounting failure stops the server run before selection and never repeats the paid classifier', async () => {
  const f = await fixture();
  const service = (await f.server.conversationService.getEventService(f.id))!;
  const append = service.state.appendEventAsync.bind(service.state);
  vi.spyOn(service.state, 'appendEventAsync').mockImplementation(async event => {
    if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'llm_usage'
      && typeof event.value === 'object' && event.value !== null && 'usage_id' in event.value && event.value.usage_id === 'classifier:classifier') throw new Error('private storage details');
    return append(event);
  });
  await send(f.server, f.id); await settle(f.server, f.id, 'error');
  expect(f.calls.map(call => call.name)).toEqual(['main', 'classifier']);
  expect((await f.metadata()).request.agent.llm_profile_ref).toBe('main');
  expect(JSON.stringify(service.events())).not.toContain('private storage details');
});
