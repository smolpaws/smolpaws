import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, ToolDefinition, llmProfileSchema, messageSchema, type LLMClient, type Message } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';
import { ConversationMetadataStore } from '../conversationMetadata.js';
import { ConversationLease } from '../conversationLease.js';

const roots: string[] = [];
const servers: AgentServerApp[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const reply = (text: string) => messageSchema.parse({ role: 'assistant', content: text });
function calls(...names: Array<[string, Record<string, unknown>]>) {
  return messageSchema.parse({ role: 'assistant', content: [], tool_calls: names.map(([name, args], index) => ({
    id: `call-${name}-${index}`, name, arguments: JSON.stringify(args), origin: 'completion',
  })) });
}

async function fixture(extra: Partial<AgentServerAppOptions> = {}, complete?: (profile: string, messages: readonly Message[]) => Promise<Message>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'profile-switch-'));
  roots.push(root);
  const observed: Array<{ profile: string; messages: readonly Message[] }> = [];
  const built: string[] = [];
  const options: AgentServerAppOptions = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root },
    secretStore: new InMemorySecretStore(),
    llmClientFactory: async (profile): Promise<LLMClient> => {
      built.push(`${profile.profileId}:${profile.model}`);
      return { profile, complete: async (messages) => {
        observed.push({ profile: profile.profileId, messages });
        return { message: complete === undefined ? reply(`done ${profile.profileId}`) : await complete(profile.profileId, messages),
          model: profile.model, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
      } };
    },
    ...extra,
  };
  const server = await createAgentServerApp(options); servers.push(server);
  for (const name of ['a', 'b', 'c']) await server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId: name, providerId: 'openai', model: `model-${name}` }));
  const start = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    agent: { condenser: { enabled: false }, llm_profile_ref: 'a', tools: ['finish', 'think'], enable_switch_llm_tool: true, tool_concurrency_limit: 2 },
  } });
  expect(start.statusCode).toBe(201);
  return { server, id: start.json<{ id: string }>().id, observed, built, root, options };
}

async function send(server: AgentServerApp, id: string, content = 'Continue') {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content, run: true } });
  expect(response.statusCode).toBe(200);
}
async function settled(server: AgentServerApp, id: string, status = 'finished') {
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe(status);
  // close the publication/save window too, so the next explicit message is a distinct run.
  await (await server.conversationService.getEventService(id))!.whenIdle();
}

test('a changed config reference rebinds the existing conversation and preserves history and usage', async () => {
  let selected: string | undefined = 'a';
  const f = await fixture({ resolveProfileSelection: () => selected });
  await send(f.server, f.id, 'first request'); await settled(f.server, f.id);
  selected = 'b';
  await send(f.server, f.id, 'second request'); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
  expect(JSON.stringify(f.observed[1]!.messages)).toContain('first request');
  const info = (await f.server.app.inject(`/api/conversations/${f.id}`)).json();
  expect(info.agent.llm_profile_ref).toBe('b');
  expect(info.launched_agent_profile.profileId).toBe('b');
  expect(Object.keys(info.stats.usage_to_metrics)).toEqual(['profile:a', 'profile:b']);
  expect(info.metrics.known_token_usage.total_tokens).toBe(24);
});

test.each([false, true])('configured selection does not require the previous profile credentials (restored=%s)', async (restore) => {
  let selected = restore ? 'a' : 'b'; let rejectOld = !restore;
  const built: string[] = [];
  const f = await fixture({ resolveProfileSelection: () => selected, llmClientFactory: async (profile) => {
    built.push(profile.profileId);
    if (profile.profileId === 'a' && rejectOld) throw new Error('old credentials unavailable');
    return { profile, complete: async () => ({ message: reply(`done ${profile.profileId}`), usage: null }) };
  } });
  let server = f.server;
  if (restore) {
    await send(server, f.id); await settled(server, f.id);
    await server.app.close(); selected = 'b'; rejectOld = true;
    server = await createAgentServerApp(f.options); servers.push(server);
  }
  await send(server, f.id); await settled(server, f.id);
  expect(built).toEqual(restore ? ['a', 'b'] : ['b']);
  expect((await server.app.inject(`/api/conversations/${f.id}`)).json().agent.llm_profile_ref).toBe('b');
});

test('switch_llm changes the next step and unchanged config does not undo it after restart', async () => {
  let first = true;
  const f = await fixture({ resolveProfileSelection: () => 'a' }, async () => {
    if (first) { first = false; return calls(['switch_llm', { profile_name: 'b', reason: 'Use the other profile.' }]); }
    return reply('done');
  });
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
  await f.server.app.close();
  const restarted = await createAgentServerApp(f.options); servers.push(restarted);
  await send(restarted, f.id); await settled(restarted, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b', 'b']);
});

// Pinned Python #3485: a switch tool must not await the run that is executing it.
test('switch_llm alongside finish commits the replacement without deadlocking and survives restart', async () => {
  let first = true;
  const f = await fixture({}, async () => {
    if (first) { first = false; return calls(['switch_llm', { profile_name: 'b', reason: 'Next turn.' }], ['finish', { message: 'done' }]); }
    return reply('continued');
  });
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a']);
  expect((await f.server.app.inject(`/api/conversations/${f.id}`)).json().agent.llm_profile_ref).toBe('b');
  await f.server.app.close();
  const restarted = await createAgentServerApp(f.options); servers.push(restarted);
  await send(restarted, f.id); await settled(restarted, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
});

test('a message received during a final completion is answered by the newly selected profile', async () => {
  const gate = deferred(); const entered = deferred();
  let selected = 'a'; let first = true;
  const f = await fixture({ resolveProfileSelection: () => selected }, async () => {
    if (first) { first = false; entered.resolve(); await gate.promise; }
    return reply('done');
  });
  await send(f.server, f.id, 'first'); await entered.promise;
  selected = 'b';
  await send(f.server, f.id, 'arrived during completion');
  expect(f.built).toEqual(['a:model-a']);
  gate.resolve();
  await expect.poll(() => f.observed.length).toBe(2);
  await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
  expect(f.observed[1]!.messages.filter((message) => message.role !== 'system')).toMatchObject([
    { role: 'user', content: messageSchema.parse({ role: 'user', content: 'first' }).content },
    { role: 'assistant', content: reply('done').content },
    { role: 'user', content: messageSchema.parse({ role: 'user', content: 'arrived during completion' }).content },
  ]);
});

test('invalid config selection fails the run without changing the effective snapshot or invoking another client', async () => {
  let selected = 'a';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture({ resolveProfileSelection: () => selected });
  await send(f.server, f.id); await settled(f.server, f.id);
  selected = 'missing';
  await send(f.server, f.id); await settled(f.server, f.id, 'error');
  expect(f.observed.map((call) => call.profile)).toEqual(['a']);
  const meta = JSON.parse(await readFile(path.join(f.root, 'conversations', f.id, 'meta.json'), 'utf8'));
  expect(meta.request.agent.llm_profile_ref).toBe('a');
  expect(meta.request.llm_profile_snapshot.profileId).toBe('a');
  selected = 'b';
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
});

test('a switch waits for every tool in its batch, retaining tool instances and completing them once', async () => {
  const entered = deferred(); const gate = deferred();
  let first = true; let executions = 0;
  const configureTools = vi.fn<NonNullable<AgentServerAppOptions['configureTools']>>((tools) => tools.map((tool) => tool.name !== 'think' ? tool : new ToolDefinition({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    executor: async () => { executions += 1; entered.resolve(); await gate.promise; return { text: 'completed once' }; },
  })));
  const f = await fixture({ configureTools }, async () => {
    if (first) { first = false; return calls(['switch_llm', { profile_name: 'b', reason: 'Continue after all tools.' }], ['think', { thought: 'slow task' }]); }
    return reply('done');
  });
  await send(f.server, f.id); await entered.promise;
  expect(f.observed.map((call) => call.profile)).toEqual(['a']);
  expect((await f.server.app.inject(`/api/conversations/${f.id}`)).json().agent.llm_profile_ref).toBe('a');
  gate.resolve(); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
  expect(JSON.stringify(f.observed[1]!.messages)).toContain('completed once');
  expect(executions).toBe(1); expect(configureTools).toHaveBeenCalledOnce();
});

test('same-reference config edits keep snapshots, explicit tool reselection refreshes, removal preserves the effective profile', async () => {
  let selected: string | undefined = 'a'; let switchNext = false;
  const f = await fixture({ resolveProfileSelection: () => selected }, async () => {
    if (switchNext) { switchNext = false; return calls(['switch_llm', { profile_name: 'a', reason: 'Refresh saved profile.' }]); }
    return reply('done');
  });
  await send(f.server, f.id); await settled(f.server, f.id);
  await f.server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId: 'a', providerId: 'openai', model: 'updated-model-a' }));
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.built).toEqual(['a:model-a']);
  switchNext = true;
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.built).toEqual(['a:model-a', 'a:updated-model-a']);
  selected = undefined;
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.built).toEqual(['a:model-a', 'a:updated-model-a']);
  expect((await f.server.app.inject(`/api/conversations/${f.id}`)).json().launched_agent_profile.model).toBe('updated-model-a');
});

test('client construction failure preserves active metadata and emits a safe tool error', async () => {
  let first = true;
  const selected: string[] = [];
  const f = await fixture({ llmClientFactory: async (profile) => {
    if (profile.profileId === 'b') throw new Error('api_key=must-not-persist Authorization: Bearer also-secret');
    return { profile, complete: async () => {
      selected.push(profile.profileId);
      const message = first ? calls(['switch_llm', { profile_name: 'b', reason: 'Use B.' }]) : reply('done');
      first = false; return { message, usage: null };
    } };
  } });
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(selected).toEqual(['a', 'a']);
  const info = (await f.server.app.inject(`/api/conversations/${f.id}`)).json();
  expect(info.agent.llm_profile_ref).toBe('a');
  const events = (await f.server.app.inject(`/api/conversations/${f.id}/events/search`)).json();
  expect(JSON.stringify(events)).not.toContain('must-not-persist');
  expect(JSON.stringify(events)).not.toContain('also-secret');
  expect(events.items.some((event: { kind: string; observation?: { is_error?: boolean } }) => event.kind === 'ObservationEvent' && event.observation?.is_error)).toBe(true);
});

test('an activation save failure keeps the original binding and restores the durably queued choice', async () => {
  let first = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture({}, async () => {
    if (first) { first = false; return calls(['switch_llm', { profile_name: 'b', reason: 'Continue using B.' }]); }
    return reply('done');
  });
  const originalSave = ConversationMetadataStore.prototype.saveConversation;
  const save = vi.spyOn(ConversationMetadataStore.prototype, 'saveConversation').mockImplementation(async function (stored) {
    if (stored.request.llm_profile_snapshot?.profileId === 'b') throw new Error('fixture activation save failure');
    return originalSave.call(this, stored);
  });
  await send(f.server, f.id); await settled(f.server, f.id, 'error');
  expect(f.observed.map((call) => call.profile)).toEqual(['a']);
  const before = (await f.server.app.inject(`/api/conversations/${f.id}`)).json();
  expect(before.agent.llm_profile_ref).toBe('a');
  const meta = JSON.parse(await readFile(path.join(f.root, 'conversations', f.id, 'meta.json'), 'utf8'));
  expect(meta.request.llm_profile_selection.pending_profile.profileId).toBe('b');
  save.mockRestore();
  await f.server.app.close();
  const restarted = await createAgentServerApp(f.options); servers.push(restarted);
  await send(restarted, f.id); await settled(restarted, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
  expect((await restarted.app.inject(`/api/conversations/${f.id}`)).json().agent.llm_profile_ref).toBe('b');
});

test('a lease cleanup failure after committing the new snapshot cannot resume the old cached agent', async () => {
  let first = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture({ resolveProfileSelection: () => 'a' }, async () => {
    if (first) { first = false; return calls(['switch_llm', { profile_name: 'b', reason: 'Use B next.' }]); }
    return reply('done');
  });
  const service = (await f.server.conversationService.getEventService(f.id))!;
  const original = ConversationLease.prototype.guardedWrite;
  let failed = false;
  vi.spyOn(ConversationLease.prototype, 'guardedWrite').mockImplementation(async function (generation, write) {
    const result = await original.call(this, generation, write);
    if (!failed && service.stored.request.llm_profile_snapshot?.profileId === 'b'
      && service.stored.request.llm_profile_selection?.pending_profile === null) {
      failed = true;
      throw new Error('fixture post-commit lease cleanup failure');
    }
    return result;
  });
  await send(f.server, f.id); await settled(f.server, f.id, 'error');
  expect(f.observed.map((call) => call.profile)).toEqual(['a']);
  const meta = JSON.parse(await readFile(path.join(f.root, 'conversations', f.id, 'meta.json'), 'utf8'));
  expect(meta.request.llm_profile_snapshot.profileId).toBe('b');
  expect(meta.request.llm_profile_selection.pending_profile).toBeNull();
  await send(f.server, f.id); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'b']);
  const info = (await f.server.app.inject(`/api/conversations/${f.id}`)).json();
  expect(info.metrics.known_token_usage.total_tokens).toBe(24);
});

test('a newer applicable config selecting the active profile cancels a pending tool choice', async () => {
  const entered = deferred(); const gate = deferred();
  let selected: string | undefined; let first = true;
  const f = await fixture({ resolveProfileSelection: () => selected,
    configureTools: (tools) => tools.map((tool) => tool.name !== 'think' ? tool : new ToolDefinition({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      executor: async () => { entered.resolve(); await gate.promise; return { text: 'done' }; },
    })),
  }, async () => {
    if (first) { first = false; return calls(['switch_llm', { profile_name: 'b', reason: 'Select B.' }], ['think', { thought: 'hold' }]); }
    return reply('done');
  });
  await send(f.server, f.id); await entered.promise;
  const service = (await f.server.conversationService.getEventService(f.id))!;
  await expect.poll(() => service.stored.request.llm_profile_selection?.pending_profile?.profileId).toBe('b');
  selected = 'a'; await send(f.server, f.id, 'Use the configured profile.');
  gate.resolve(); await settled(f.server, f.id);
  expect(f.observed.map((call) => call.profile)).toEqual(['a', 'a']);
  expect(service.stored.request.llm_profile_selection).toEqual({ configured_ref: 'a', pending_profile: null });
});

test('public callers cannot inject a pending profile or configuration-observation marker', async () => {
  const f = await fixture();
  const b = await f.server.serverStateService.getProfile('b');
  const result = await f.server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    agent: { condenser: { enabled: false }, llm_profile_ref: 'a' }, llm_profile_snapshot: b,
    llm_profile_selection: { configured_ref: 'b', pending_profile: b },
  } });
  expect(result.statusCode).toBe(201);
  const stored = (await f.server.conversationService.getEventService(result.json().id))!.stored;
  expect(stored.request.llm_profile_snapshot?.profileId).toBe('a');
  expect(stored.request.llm_profile_selection).toBeUndefined();
});

test.each([
  { enabled: true, explicit: false, count: 1 },
  { enabled: false, explicit: false, count: 0 },
  { enabled: true, explicit: true, count: 1 },
  { enabled: false, explicit: true, count: 1 },
])('switch tool registration follows automatic/explicit settings: $enabled / $explicit', async ({ enabled, explicit, count }) => {
  const names: string[][] = [];
  const f = await fixture({ llmClientFactory: async (profile) => ({ profile, complete: async (_messages, tools) => {
    names.push(tools?.map((tool) => tool.name) ?? []);
    return { message: reply('done'), usage: null };
  } }) });
  const start = await f.server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    agent: { condenser: { enabled: false }, llm_profile_ref: 'a', tools: explicit ? ['switch_llm', 'finish'] : ['finish'], enable_switch_llm_tool: enabled },
  } });
  expect(start.statusCode).toBe(201);
  await send(f.server, start.json().id); await settled(f.server, start.json().id);
  expect(names[0]!.filter((name) => name === 'switch_llm')).toHaveLength(count);
});
