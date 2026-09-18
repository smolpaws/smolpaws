import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentContext, InMemorySecretStore, Skill, llmProfileSchema, messageSchema, type Message } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAgentServerApp, type AgentServerApp, type AgentServerAppOptions } from '../app.js';
import { createProfileAgentFactory, type ProfileContextConfigurator } from '../profileAgentFactory.js';

const profile = llmProfileSchema.parse({ profileId: 'context-test', providerId: 'openai', model: 'test-model' });
const roots: string[] = [];
const servers: AgentServerApp[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function fixture(options: Pick<AgentServerAppOptions, 'configureContext' | 'configureTools'> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-profile-context-'));
  roots.push(root);
  const complete = vi.fn(async (_messages: readonly Message[]) => ({
    message: messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: 'finish-call', name: 'finish', arguments: JSON.stringify({ message: 'done' }), origin: 'completion' }] }),
    usage: null,
  }));
  const secretStore = new InMemorySecretStore();
  const llmClientFactory = vi.fn(async () => ({ profile, complete }));
  const server = await createAgentServerApp({
    ...options,
    secretStore,
    llmClientFactory,
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: root },
  });
  servers.push(server);
  await server.serverStateService.saveProfile(profile);
  return { server, complete, secretStore, llmClientFactory };
}

async function start(server: AgentServerApp, suffix?: string): Promise<string> {
  const response = await server.app.inject({
    method: 'POST', url: '/api/conversations',
    payload: {
      agent: { condenser: { enabled: false }, llm_profile_ref: profile.profileId, tools: ['finish'] },
      ...(suffix === undefined ? {} : { agent_launch_additions: { system_message_suffix_append: suffix } }),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

async function run(server: AgentServerApp, id: string, status = 'finished'): Promise<void> {
  const response = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Finish this turn.', run: true } });
  expect(response.statusCode).toBe(200);
  await expect.poll(async () => (await server.app.inject(`/api/conversations/${id}`)).json().execution_status).toBe(status);
}

function systemPrompt(messages: readonly Message[]): string {
  return messages.filter((message) => message.role === 'system').flatMap((message) => message.content).flatMap((content) => content.type === 'text' ? [content.text] : []).join('\n');
}

describe('profile agent context configuration', () => {
  test('loads a full always-on skill alongside launch additions before the first request, once per agent', async () => {
    const memory = `# MEMORY.md\n${'durable context\n'.repeat(3500)}end-of-memory`;
    const order: string[] = [];
    const configureContext = vi.fn<ProfileContextConfigurator>(async (existingContext, factoryContext) => {
      order.push('context');
      expect(existingContext?.systemMessageSuffix).toBe('Original launch suffix');
      expect(factoryContext.stored.request.agent).toMatchObject({ llm_profile_ref: profile.profileId });
      return new AgentContext({
        systemMessageSuffix: existingContext?.systemMessageSuffix ?? null,
        skills: [new Skill({ name: 'durable-memory', content: memory, trigger: null })],
      });
    });
    const { server, complete } = await fixture({
      configureContext,
      configureTools: (tools) => { order.push('tools'); return tools; },
    });
    const id = await start(server, 'Original launch suffix');
    await run(server, id);
    expect(memory.length).toBeGreaterThan(32768);
    const prompt = systemPrompt(complete.mock.calls[0]![0]);
    expect(prompt.includes(memory)).toBe(true);
    expect(prompt).toContain('<REPO_CONTEXT>');
    expect(prompt).toContain('Original launch suffix');
    expect(configureContext.mock.calls[0]![1].stored.id).toBe(id);
    await run(server, id);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(configureContext).toHaveBeenCalledOnce();
    expect(order).toEqual(['tools', 'context']);
  });

  test('keeps a bare profile context null and preserves launch suffix behavior without a configurator', async () => {
    const { server, complete, secretStore, llmClientFactory } = await fixture();
    const factory = createProfileAgentFactory({ state: server.serverStateService, secretStore, llmClientFactory });
    const bareId = await start(server);
    const bare = (await server.conversationService.getEventService(bareId))!;
    expect((await factory(bare.stored.request.agent, { stored: bare.stored })).context).toBeNull();
    await run(server, bareId);
    expect(systemPrompt(complete.mock.calls[0]![0])).not.toContain('<REPO_CONTEXT>');

    const suffixId = await start(server, 'Unchanged launch suffix');
    await run(server, suffixId);
    expect(systemPrompt(complete.mock.calls[1]![0])).toContain('Unchanged launch suffix');
    const tooLong = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { condenser: { enabled: false }, llm_profile_ref: profile.profileId }, agent_launch_additions: { system_message_suffix_append: 'x'.repeat(32769) } } });
    expect(tooLong.statusCode).toBe(422);
  });

  test('passes null to the configurator for a bare profile and accepts a null result', async () => {
    const configureContext = vi.fn<ProfileContextConfigurator>(() => null);
    const { server, complete } = await fixture({ configureContext });
    const id = await start(server);
    await run(server, id);
    expect(configureContext.mock.calls[0]![0]).toBeNull();
    expect(systemPrompt(complete.mock.calls[0]![0])).not.toContain('<REPO_CONTEXT>');
  });

  test('surfaces configuration failures and does not run without the required context', async () => {
    const failure = new Error('required_context_unavailable');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { server, llmClientFactory, complete } = await fixture({ configureContext: async () => { throw failure; } });
    const id = await start(server);
    await run(server, id, 'error');
    expect(errorLog).toHaveBeenCalledWith('conversation_run_error', { code: 'Error', detail: 'required_context_unavailable' });
    expect(llmClientFactory).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
