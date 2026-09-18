import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, llmProfileSchema, messageSchema } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';

const roots: string[] = [];
const servers: AgentServerApp[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'condenser-workflow-')); roots.push(root);
  let main = 'main'; let summary = 'summary';
  const calls: string[] = [];
  const built: string[] = [];
  const selectCondenser = vi.fn<NonNullable<AgentServerAppOptions['resolveCondenserProfileSelection']>>(() => summary);
  const options: AgentServerAppOptions = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, bashEventsPath: path.join(root, 'bash') },
    secretStore: new InMemorySecretStore(),
    resolveProfileSelection: () => main,
    resolveCondenserProfileSelection: selectCondenser,
    llmClientFactory: async profile => {
      built.push(`${profile.profileId}:${profile.model}`);
      return { profile, effectiveMaxInputTokens: profile.profileId === 'main' ? 900 : 4000,
        complete: async () => {
          calls.push(`${profile.profileId}:${profile.model}`);
          return { message: messageSchema.parse({ role: 'assistant', content: `Completed with ${profile.profileId}` }),
            usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 }, model: profile.model };
        } };
    },
  };
  const server = await createAgentServerApp(options); servers.push(server);
  for (const profileId of ['main', 'other', 'summary', 'new-summary']) {
    await server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId, providerId: 'openai', model: `model-${profileId}` }));
  }
  const start = async (payload: Record<string, unknown> = {}) => {
    const response = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
      agent: { llm_profile_ref: 'main', tools: ['finish'] }, ...payload,
    } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  };
  return { root, options, server, start, calls, built, selectCondenser,
    choose: (agent: string, condenser: string) => { main = agent; summary = condenser; },
    metadata: async (id: string) => JSON.parse(await readFile(path.join(root, 'conversations', id, 'meta.json'), 'utf8')),
  };
}

async function run(server: AgentServerApp, id: string, status = 'finished') {
  expect((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { content: 'Continue', run: true } })).statusCode).toBe(200);
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe(status);
  await (await server.conversationService.getEventService(id))!.whenIdle();
}

async function condense(server: AgentServerApp, id: string) {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/condense`, payload: {} });
  expect(response.statusCode, response.body).toBe(200);
}

test('frozen summary profile and inherited cap survive catalog deletion, main switch, fork, and disk restart', async () => {
  const f = await fixture();
  const id = await f.start();
  expect((await f.metadata(id)).request.condenser_binding).toBeUndefined();
  await run(f.server, id);
  const binding = (await f.metadata(id)).request.condenser_binding;
  expect(binding).toMatchObject({ profile: { profileId: 'summary', model: 'model-summary' }, settings: { max_tokens: 900 } });
  await f.server.serverStateService.deleteProfile('summary');
  f.choose('other', 'new-summary');
  await run(f.server, id);
  await condense(f.server, id);
  expect(f.calls).toContain('summary:model-summary');
  expect(f.calls).not.toContain('new-summary:model-new-summary');
  expect(f.selectCondenser).toHaveBeenCalledOnce();
  const forkResponse = await f.server.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, payload: {} });
  expect(forkResponse.statusCode).toBe(201);
  const forkId = forkResponse.json<{ id: string }>().id;
  expect((await f.metadata(forkId)).request.condenser_binding).toEqual(binding);
  await f.server.app.close();
  const restarted = await createAgentServerApp(f.options); servers.push(restarted);
  for (const conversationId of [id, forkId]) {
    await run(restarted, conversationId);
    await condense(restarted, conversationId);
    expect((await f.metadata(conversationId)).request.condenser_binding).toEqual(binding);
  }
  expect(f.selectCondenser).toHaveBeenCalledOnce();
  const source = (await restarted.conversationService.getEventService(id))!;
  expect(source.state.stats.usage_to_metrics.condenser?.records.every(record => record.profile_id === 'summary')).toBe(true);
});

test('fork before first use performs no client work and captures its own later role selection', async () => {
  const f = await fixture();
  const id = await f.start();
  const forkResponse = await f.server.app.inject({ method: 'POST', url: `/api/conversations/${id}/fork`, payload: {} });
  expect(forkResponse.statusCode).toBe(201);
  const forkId = forkResponse.json<{ id: string }>().id;
  expect(f.built).toEqual([]);
  expect(f.selectCondenser).not.toHaveBeenCalled();
  f.selectCondenser.mockImplementation(({ stored }) => stored.id === forkId ? 'new-summary' : 'summary');
  await run(f.server, id); await run(f.server, forkId);
  expect((await f.metadata(id)).request.condenser_binding.profile.profileId).toBe('summary');
  expect((await f.metadata(forkId)).request.condenser_binding.profile.profileId).toBe('new-summary');
});

test('HTTP callers cannot forge a frozen condenser binding', async () => {
  const f = await fixture();
  const id = await f.start({ condenser_binding: { profile: { profileId: 'attacker', providerId: 'openai', model: 'forged' }, settings: { llm_profile_ref: 'attacker', max_tokens: 12 } } });
  expect((await f.metadata(id)).request.condenser_binding).toBeUndefined();
  await run(f.server, id);
  expect((await f.metadata(id)).request.condenser_binding.profile.profileId).toBe('summary');
  expect(f.built.some(value => value.includes('attacker'))).toBe(false);
});

test('missing first-use selection persists a clear run error without a main-model fallback', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const f = await fixture(); f.selectCondenser.mockReturnValue(undefined);
  const id = await f.start();
  await run(f.server, id, 'error');
  expect(f.calls).toEqual([]);
  expect((await f.metadata(id)).request.condenser_binding).toBeUndefined();
  const events = (await f.server.conversationService.getEventService(id))!.state.events;
  expect(JSON.stringify(events.filter(event => event.kind === 'ConversationErrorEvent'))).toContain('condenser_profile_required');
});


test('legacy disk requests inherit and pin effective agent settings with their first condenser binding', async () => {
  const f = await fixture();
  const id = await f.start();
  await f.server.serverStateService.updateSettings({ agent_settings: {
    llm_profile_ref: 'main', tools: ['finish'], condenser: { max_size: 32, keep_first: 3, max_tokens: 300 },
  } });
  for (let index = 0; index < 6; index += 1) {
    expect((await f.server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { content: `Legacy message ${index}`, run: false } })).statusCode).toBe(200);
  }
  await f.server.app.close();
  const legacy = await f.metadata(id);
  delete legacy.request.agent;
  delete legacy.request.llm_profile_snapshot;
  delete legacy.request.llm_profile_selection;
  await writeFile(path.join(f.root, 'conversations', id, 'meta.json'), JSON.stringify(legacy));
  const legacyOptions = { ...f.options };
  delete legacyOptions.resolveProfileSelection;
  const restored = await createAgentServerApp(legacyOptions); servers.push(restored);
  // An edit to the global defaults during profile resolution must not alter the
  // inherited settings already selected by this factory invocation.
  f.selectCondenser.mockImplementationOnce(async () => {
    await restored.serverStateService.updateSettings({ agent_settings: {
      llm_profile_ref: 'other', tools: ['finish'], condenser: { enabled: false },
    } });
    return 'summary';
  });
  await condense(restored, id);
  const captured = (await f.metadata(id)).request;
  expect(captured.agent).toMatchObject({ llm_profile_ref: 'main', condenser: { max_size: 32, keep_first: 3, max_tokens: 300 } });
  expect(captured.condenser_binding).toMatchObject({ profile: { profileId: 'summary' }, settings: { max_size: 32, keep_first: 3, max_tokens: 300 } });
  await restored.app.close();
  const restarted = await createAgentServerApp(legacyOptions); servers.push(restarted);
  await condense(restarted, id);
  expect((await f.metadata(id)).request.condenser_binding).toEqual(captured.condenser_binding);
  expect(f.selectCondenser).toHaveBeenCalledOnce();
});
