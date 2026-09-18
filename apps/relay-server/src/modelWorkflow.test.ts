import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { createRelayServerApp } from './app.js';
const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

test('custom agent factories remain usable; explicit model configuration requires the managed factory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'product-custom-factory-'));
  let factoryCalls = 0;
  const agentFactory = () => { factoryCalls += 1; return new sdk.Agent({ llm: sdk.TestLLM.fromMessages([
    sdk.messageSchema.parse({ role: 'assistant', content: 'Custom agent answered' }),
  ]) }); };
  const options = { config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root },
    secretStore: new sdk.InMemorySecretStore(), agentFactory };
  const server = await createRelayServerApp(options, new TaskScheduler(path.join(root, 'scheduler.db')));
  try {
    const response = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
      initial_message: { role: 'user', content: 'Hello', run: true },
    } });
    assert.equal(response.statusCode, 201);
    await (await server.conversationService.getEventService(response.json().id))!.whenIdle();
    assert.equal(factoryCalls, 1);
    await assert.rejects(() => createRelayServerApp({ ...options, models: { configPath: path.join(root, 'models.json') } },
      new TaskScheduler(path.join(root, 'other-scheduler.db'))), /requires the profile agent factory/);
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const platform of ['whatsapp', 'slack', 'agent-server']) test(`${platform} uses shared config for an existing conversation and preserves agent tool choices`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'product-model-workflow-'));
  const configPath = path.join(root, 'models.json');
  const contextPath = path.join(root, 'context.json');
  writeFileSync(contextPath, JSON.stringify({ version: 1, files: [] }));
  const scheduler = new TaskScheduler(path.join(root, 'scheduler.db'));
  const id = randomUUID();
  const scopeId = platform === 'agent-server' ? `agent-server:${id}` : 'main';
  const scope = `${platform}:${scopeId}`;
  const setModel = (name: string, oracle?: string) => {
    writeFileSync(`${configPath}.tmp`, JSON.stringify({ version: 1, scopes: { [scope]: { agent: name, ...(oracle ? { oracle } : {}) } } }));
    renameSync(`${configPath}.tmp`, configPath);
  };
  setModel('a');
  if (platform !== 'agent-server') scheduler.register({ conversationId: id, scopeId, workingDir: root,
    relayDbPath: path.join(root, 'relay.db'), defaults: {},
    lane: { laneKey: `${platform}:test`, platform, accountId: null, chatId: 'test', threadId: null } });
  const calls: Array<{ profile: string; messages: readonly Sdk.Message[] }> = [];
  let toolRequested = false;
  const server = await createRelayServerApp({
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root },
    models: { configPath }, context: { configPath: contextPath }, secretStore: new sdk.InMemorySecretStore(),
    llmClientFactory: async profile => ({ profile, complete: async (messages, tools) => {
      calls.push({ profile: profile.profileId, messages });
      assert.ok(tools?.some(tool => tool.name === 'switch_llm'));
      const switchNow = profile.profileId === 'b' && !toolRequested;
      if (switchNow) toolRequested = true;
      return { model: profile.model, usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        message: sdk.messageSchema.parse(switchNow
          ? { role: 'assistant', content: [], tool_calls: [{ id: 'switch-choice', name: 'switch_llm',
              arguments: JSON.stringify({ profile_name: 'c', reason: 'Use profile C for this task.' }), origin: 'completion' }] }
          : { role: 'assistant', content: `answered with ${profile.profileId}` }) };
    } }),
  }, scheduler);
  async function send(content: string) {
    assert.equal((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content, run: true } })).statusCode, 200);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const info = (await server.app.inject(`/api/conversations/${id}`)).json();
      if (info.execution_status === 'error') assert.fail('Conversation failed during model workflow');
      if (info.execution_status === 'finished') {
        await (await server.conversationService.getEventService(id))!.whenIdle();
        return (await server.app.inject(`/api/conversations/${id}`)).json();
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Conversation did not finish');
  }
  try {
    for (const name of ['a', 'b', 'c']) await server.serverStateService.saveProfile(sdk.llmProfileSchema.parse({ profileId: name, providerId: 'openai', model: `model-${name}` }));
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { id,
      workspace: { working_dir: root }, agent: { condenser: { enabled: false }, llm_profile_ref: 'c', tools: ['finish', 'think'], enable_switch_llm_tool: true } } });
    assert.equal(started.statusCode, 201);
    const first = await send('Remember the first request');
    assert.equal(first.agent.llm_profile_ref, 'a');
    const contextBefore = readFileSync(path.join(root, 'conversations', id, 'smolpaws-context.json'), 'utf8');
    setModel('b');
    const second = await send('Continue and choose another profile if useful');
    assert.equal(second.agent.llm_profile_ref, 'c');
    assert.deepEqual(calls.map(call => call.profile), ['a', 'b', 'c']);
    assert.ok(JSON.stringify(calls[2]!.messages).includes('Remember the first request'));
    setModel('b', 'a'); // Unrelated role edit must not erase the agent's explicit choice.
    const third = await send('Continue again');
    assert.equal(third.agent.llm_profile_ref, 'c');
    setModel('a');
    const fourth = await send('Apply changed channel selection');
    assert.equal(fourth.agent.llm_profile_ref, 'a');
    assert.deepEqual(calls.map(call => call.profile), ['a', 'b', 'c', 'c', 'a']);
    assert.equal(fourth.id, id);
    assert.equal(fourth.metrics.known_token_usage.total_tokens, 60);
    assert.equal(readFileSync(path.join(root, 'conversations', id, 'smolpaws-context.json'), 'utf8'), contextBefore);
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});
