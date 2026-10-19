import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InMemorySecretStore, ToolDefinition, globalToolRegistry, llmProfileSchema, messageSchema, validateAgentProfile, type LLMClient } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';
import { createProfileAgentFactory, prepareProfileStartRequest } from '../profileAgentFactory.js';
import { startConversationRequestSchema, type StoredConversation } from '../models.js';
import { ServerStateService } from '../serverState.js';
import { selectRouterToolSpec } from '../routerToolSpecs.js';
import { ConversationProfileRuntime } from '../profileRuntime.js';
import { previewClient, previewServerProfile } from '../launch.js';
import { createProfileToolMaterializer } from '../profileTools.js';
import { registerToolRoutes } from '../toolRouter.js';
import Fastify from 'fastify';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(tools?: unknown[], extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-catalog-')); roots.push(root);
  const secretStore = new InMemorySecretStore();
  const state = new ServerStateService({ stateDir: path.join(root, 'state'), secretStore });
  const profile = llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'model-main' });
  await state.saveProfile(profile);
  const request = startConversationRequestSchema.parse({ id: randomUUID(), persistence_dir: root, workspace: { working_dir: root },
    agent: { llm_profile_ref: 'main', condenser: { enabled: false }, ...(tools === undefined ? {} : { tools }), ...extra }, llm_profile_snapshot: profile });
  const stored: StoredConversation = { id: request.id!, request, workspace: request.workspace, title: null, tags: {}, secret_names: [], created_at: '2026-01-01', updated_at: '2026-01-01' };
  const createClient = vi.fn(async (selected): Promise<LLMClient> => ({ profile: selected, complete: async () => ({ message: messageSchema.parse({ role: 'assistant', content: 'done' }), usage: null }) }));
  const factory = createProfileAgentFactory({ state, secretStore, llmClientFactory: createClient });
  return { root, state, stored, secretStore, createClient, factory, build: () => factory(stored.request.agent, { stored }) };
}

test('fresh explicit empty tools remain bare while omitted tools use the canonical native default set', async () => {
  const bare = await fixture([]); expect((await bare.build()).tools.map(tool => tool.name)).toEqual(['finish', 'think']);
  const defaults = await fixture(); expect((await defaults.build()).tools.map(tool => tool.name)).toEqual(['terminal', 'file_editor', 'task_tracker', 'switch_llm', 'finish', 'think']);
});

test('persona survives factory construction and the durable profile activation boundary', async () => {
  const f = await fixture([], { persona: 'A careful feline engineer.' });
  const agent = await f.build(); expect(agent.persona).toBe('A careful feline engineer.');
  const next = llmProfileSchema.parse({ profileId: 'next', providerId: 'openai', model: 'next-model' });
  const runtime = new ConversationProfileRuntime(f.stored, { getProfile: async () => next, createClient: f.createClient }, async update => { f.stored.request = startConversationRequestSchema.parse(update(f.stored.request)); });
  await runtime.switchProfile('next');
  const replacement = await runtime.activate(agent);
  expect(replacement?.persona).toBe(agent.persona);
});

test('canonical router duplicate selection keeps the first parameterized entry while validating every entry', () => {
  expect(selectRouterToolSpec([{ name: 'route_task_to_model' }, { name: 'ClassifyAndSwitchLLMTool', params: { active_meta_profile: 'first' } },
    { name: 'route_task_to_model', params: { active_meta_profile: 'second' } }])).toMatchObject({ name: 'route_task_to_model', params: { active_meta_profile: 'first' } });
  expect(() => selectRouterToolSpec([{ name: 'route_task_to_model', params: { active_meta_profile: 'first' } },
    { name: 'route_task_to_model', params: { api_key: 'private' } }])).toThrow('Invalid');
});

test('default task trackers persist independently under their conversation directories and restore', async () => {
  const f = await fixture();
  const first = await f.build();
  const tracker = first.tools.find(tool => tool.name === 'task_tracker'); expect(tracker).toBeDefined();
  await tracker!.execute({ command: 'plan', task_list: [{ title: 'First', status: 'todo', notes: '' }] });
  expect(await readFile(path.join(f.root, f.stored.id, 'TASKS.json'), 'utf8')).toContain('First');
  const secondStored = { ...f.stored, id: randomUUID() };
  const second = await f.factory(secondStored.request.agent, { stored: secondStored });
  const secondTracker = second.tools.find(tool => tool.name === 'task_tracker')!;
  expect(await secondTracker.execute({ command: 'view' })).not.toMatchObject({ task_list: [{ title: 'First' }] });
  const restored = await f.build();
  expect(await restored.tools.find(tool => tool.name === 'task_tracker')!.execute({ command: 'view' })).toMatchObject({ task_list: [{ title: 'First' }] });
  expect(await readdir(path.join(f.root, f.stored.id))).toEqual(['TASKS.json']);
});

test('staged launch preserves captured inputs while a real-context condenser role is resolved and durably frozen', async () => {
  const f = await fixture([], { condenser: { enabled: true, max_size: 24, keep_first: 1 }, persona: 'Original persona.' });
  f.stored.request = await prepareProfileStartRequest({ ...f.stored.request, agent_launch_additions: { system_message_suffix_append: 'Once only.' } }, f.state, { deferCondenserResolution: true });
  expect(f.stored.request.launch_source).toEqual({ kind: 'missing_condenser_ref' });
  await f.state.saveProfile({ ...f.stored.request.llm_profile_snapshot!, model: 'new-main-catalog' });
  const updateRequest = vi.fn(async update => { f.stored.request = startConversationRequestSchema.parse(update(f.stored.request)); });
  const select = vi.fn(async context => { expect(context.stored).toBe(f.stored); return 'main'; });
  const factory = createProfileAgentFactory({ state: f.state, secretStore: f.secretStore, llmClientFactory: f.createClient, resolveCondenserProfileSelection: select });
  const agent = await factory(f.stored.request.agent, { stored: f.stored, updateRequest });
  expect(agent.llm.profile.model).toBe('model-main');
  expect(agent.condenser).toMatchObject({ llm: { profile: { model: 'new-main-catalog' } }, maxSize: 24, keepFirst: 1 });
  expect(agent.persona).toBe('Original persona.');
  expect(agent.context?.systemMessageSuffix).toBe('Once only.');
  expect(f.stored.request.launch_source).toBeUndefined();
  expect(f.stored.request.condenser_binding?.profile.model).toBe('new-main-catalog');
  await f.state.deleteProfile('main');
  const restored = await factory(f.stored.request.agent, { stored: f.stored, updateRequest });
  expect(restored.llm.profile.model).toBe('model-main');
  expect(restored.condenser).toMatchObject({ llm: { profile: { model: 'new-main-catalog' } } });
  expect(restored.context?.systemMessageSuffix).toBe('Once only.');
  expect(select).toHaveBeenCalledOnce();
});

test('staged capture refuses a concurrently changed request and never constructs a client', async () => {
  const f = await fixture([], { condenser: { enabled: true } });
  f.stored.request = await prepareProfileStartRequest(f.stored.request, f.state, { deferCondenserResolution: true });
  const factory = createProfileAgentFactory({ state: f.state, secretStore: f.secretStore, llmClientFactory: f.createClient,
    resolveCondenserProfileSelection: async () => 'main' });
  await expect(factory(f.stored.request.agent, { stored: f.stored, updateRequest: async update => {
    f.stored.request = startConversationRequestSchema.parse({ ...f.stored.request, agent: { ...(f.stored.request.agent as object), persona: 'External edit.' } });
    f.stored.request = update(f.stored.request);
  } })).rejects.toThrow('launch_configuration_changed_during_capture');
  expect(f.createClient).not.toHaveBeenCalled();
  expect(f.stored.request.launch_source).toBeDefined();
});

test('tool catalog lists executable native tools without constructing factories or claiming absent browser/delegation support', async () => {
  const create = vi.fn(() => { throw new Error('catalog must not create tools'); });
  const unique = `catalog_${randomUUID()}`;
  globalToolRegistry.registerFactory(unique, create, { catalogDescription: 'Fixture factory.' });
  const app = Fastify();
  try {
    registerToolRoutes(app);
    const listing = (await app.inject('/api/tools/')).json<string[]>();
    const entries = (await app.inject('/api/tools/catalog')).json<{tools:Array<{name:string;in_default_set:boolean;usable:boolean}>}>().tools;
    expect(listing).toEqual(expect.arrayContaining(['terminal', 'file_editor', 'task_tracker', 'switch_llm', unique]));
    expect(entries.map(tool => tool.name)).toEqual(expect.arrayContaining(['terminal', 'file_editor', 'task_tracker', 'switch_llm']));
    expect(entries.map(tool => tool.name)).not.toContain('SwitchLLMTool');
    expect(entries.map(tool => tool.name)).not.toContain('browser_tool_set');
    expect(entries.map(tool => tool.name)).not.toContain('task_tool_set');
    expect(create).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

test('shared preview and factory refuse nonempty MCP without a real host materializer', async () => {
  const f = await fixture([], { mcp_config: { remote: { url: 'https://example.invalid/mcp' } } });
  await expect(f.build()).rejects.toThrow('Selected tools could not be materialized');
  await f.state.updateSettings({ agent_settings: f.stored.request.agent });
  const diagnostics = await previewServerProfile(validateAgentProfile({ name: 'Preview', llm_profile_ref: 'main', tools: [], condenser: { enabled: false } }), f.state, {
    createClient: previewClient, materializeTools: createProfileToolMaterializer({ state: f.state, secretStore: f.secretStore, workingDir: f.root, persistenceDir: null }),
  });
  expect(diagnostics.valid).toBe(false);
  expect(diagnostics.resolved_mcp_config_keys).toEqual(['remote']);
  expect(diagnostics.errors).toContain('Selected tools could not be materialized');
  expect(await readdir(f.root)).toEqual(['state']);
});

test('module provenance follows retained implementation identity, caller overrides and client exclusions', async () => {
  const f = await fixture(['terminal', 'file_editor', 'task_tracker']);
  f.stored.request = await prepareProfileStartRequest({ ...f.stored.request,
    tool_module_qualnames: { file_editor: 'caller.custom.editor' }, client_tools: [{ name: 'task_tracker' }] }, f.state);
  const factory = createProfileAgentFactory({ state: f.state, secretStore: f.secretStore, llmClientFactory: f.createClient,
    configureTools: tools => tools.map(tool => tool.name === 'terminal' ? new ToolDefinition({ name: 'terminal', description: 'Replacement', inputSchema: tool.inputSchema, executor: () => ({}) }) : tool) });
  await factory(f.stored.request.agent, { stored: f.stored, updateRequest: async update => { f.stored.request = startConversationRequestSchema.parse(update(f.stored.request)); } });
  expect(f.stored.request.tool_module_qualnames).toEqual({ file_editor: 'caller.custom.editor' });
  const unmodified = await fixture(['terminal']);
  unmodified.stored.request = await prepareProfileStartRequest(unmodified.stored.request, unmodified.state);
  await unmodified.factory(unmodified.stored.request.agent, { stored: unmodified.stored, updateRequest: async update => { unmodified.stored.request = startConversationRequestSchema.parse(update(unmodified.stored.request)); } });
  expect(unmodified.stored.request.tool_module_qualnames.terminal).toBe('openhands.tools.terminal.definition');
});
