import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, llmProfileSecretRef } from '@smolpaws/openhands-agent';
import { afterEach, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp } from '../app.js';

const roots: string[] = [];
const servers: AgentServerApp[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.app.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const writes = [
  { label: 'conversation', method: 'POST', url: '/api/conversations', body: (tools: unknown[]) => ({ agent: { llm_profile_ref: 'default', tools } }) },
  { label: 'settings', method: 'PATCH', url: '/api/settings', body: (tools: unknown[]) => ({ agent_settings: { llm_profile_ref: 'default', tools }, llm_api_key: 'must-not-replace-existing-key' }) },
  { label: 'named agent profile', method: 'POST', url: '/api/agent-profiles/guarded', body: (tools: unknown[]) => ({ llm_profile_ref: 'default', tools }) },
  { label: 'collection agent profile', method: 'POST', url: '/api/agent-profiles', body: (tools: unknown[]) => ({ name: 'guarded', llm_profile_ref: 'default', tools }) },
] as const;

for (const write of writes) {
  test.each(['route_task_to_model', 'ClassifyAndSwitchLLMTool'])(`${write.label} rejects unsafe explicit %s params before any persistence`, async alias => {
    const f = await fixture();
    const before = await readFile(f.stateFile, 'utf8');
    // The second entry would be shadowed by router deduplication. Every supplied
    // spec must still validate before its raw payload can enter persisted state.
    const tools = [
      { name: 'route_task_to_model', params: { active_meta_profile: 'safe' } },
      { name: alias, params: { meta_profile_llms: { classifier: { profileId: 'classifier', providerId: 'openai', model: 'fixture', api_key: 'private-router-key' } } } },
    ];
    const response = await f.server.app.inject({ method: write.method, url: write.url, payload: write.body(tools) });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.body).not.toContain('private-router-key');
    expect(await readFile(f.stateFile, 'utf8')).toBe(before);
    expect(await f.secrets.get(llmProfileSecretRef('default'))).toBe('existing-key');
    expect((await f.server.app.inject('/api/conversations/count')).json()).toBe(0);
    expect(f.clientFactory).not.toHaveBeenCalled();
    expect(f.loadMeta).not.toHaveBeenCalled();
    expect(f.listMeta).not.toHaveBeenCalled();
  });
}

test('native explicit router params are accepted without resolving profiles, clients or store files', async () => {
  const f = await fixture();
  const tools = [{ name: 'route_task_to_model', params: {
    active_meta_profile: 'not-yet-saved',
    meta_profile: { classifier_model: 'classifier', classes: [{ description: 'work', model: 'target' }] },
    meta_profile_llms: { classifier: { profileId: 'classifier', providerId: 'openai', model: 'fixture', useProfileKeyOverride: true } },
  } }];
  for (const write of writes) {
    const response = await f.server.app.inject({ method: write.method, url: write.url, payload: write.body(tools) });
    expect(response.statusCode, response.body).toBe(write.method === 'PATCH' ? 200 : 201);
  }
  expect(f.clientFactory).not.toHaveBeenCalled();
  expect(f.loadMeta).not.toHaveBeenCalled();
  expect(f.listMeta).not.toHaveBeenCalled();
});

test('router validation rejects unknown params but does not change unrelated tool contracts', async () => {
  const f = await fixture();
  const invalid = await f.server.app.inject({ method: 'PATCH', url: '/api/settings', payload: {
    agent_settings: { llm_profile_ref: 'default', tools: [{ name: 'route_task_to_model', params: { api_key: 'private-router-key' } }] },
  } });
  expect(invalid.statusCode, invalid.body).toBe(422);
  expect(invalid.body).not.toContain('private-router-key');
  const valid = await f.server.app.inject({ method: 'PATCH', url: '/api/settings', payload: {
    agent_settings: { llm_profile_ref: 'default', tools: [{ name: 'host_tool', params: { deployment_option: 'preserved' } }] },
  } });
  expect(valid.statusCode, valid.body).toBe(200);
  expect(valid.json().agent_settings.tools).toEqual([{ name: 'host_tool', params: { deployment_option: 'preserved' } }]);
});

test('custom agent factories cannot bypass public router validation while opaque host tools remain accepted', async () => {
  const f = await fixture(true);
  const invalid = await f.server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
    agent: { tools: [{ name: 'ClassifyAndSwitchLLMTool', params: { api_key: 'private-router-key' } }] },
  } });
  expect(invalid.statusCode, invalid.body).toBe(422);
  expect(invalid.body).not.toContain('private-router-key');
  expect((await f.server.app.inject('/api/conversations/count')).json()).toBe(0);
  const opaqueAgent = { deployment_owned: 'preserved', tools: [{ name: 'host_tool', params: { deployment_option: 'preserved' } }] };
  const valid = await f.server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: opaqueAgent } });
  expect(valid.statusCode, valid.body).toBe(201);
  expect(valid.json().agent).toEqual(opaqueAgent);
});

async function fixture(customAgentFactory = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'router-validation-')); roots.push(root);
  const secrets = new InMemorySecretStore();
  await secrets.set(llmProfileSecretRef('default'), 'existing-key');
  const clientFactory = vi.fn(async () => { throw new Error('Validation must not construct a client'); });
  const server = await createAgentServerApp({ secretStore: secrets, llmClientFactory: clientFactory,
    ...(customAgentFactory ? { agentFactory: async () => { throw new Error('Validation must not construct an agent'); } } : {}),
    config: { statePath: path.join(root, 'state'), conversationsPath: path.join(root, 'conversations'), workspaceRoot: root, bashEventsPath: path.join(root, 'bash') },
  });
  servers.push(server);
  await server.serverStateService.updateSettings({});
  const loadMeta = vi.spyOn(server.serverStateService.metaProfileStore, 'load');
  const listMeta = vi.spyOn(server.serverStateService.metaProfileStore, 'list');
  return { server, secrets, clientFactory, loadMeta, listMeta, stateFile: path.join(root, 'state', 'state.json') };
}
