import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { HttpAgentServerClient } from '../../../src/coordinator/httpAgentServerClient.js';
import { MessageRelay } from '../../../src/coordinator/messageRelay.js';
import { MessageWorkStore } from '../../../src/coordinator/store.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { createRelayServerApp } from './app.js';

// Match the server's ESM runtime so typed provider errors share their instanceof identity.
const sdk = await import(new URL('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.mjs', import.meta.url).href) as typeof Sdk;

for (const selection of ['scoped', 'global', 'explicit'] as const) test(`${selection} condenser selection uses the trusted product lane and summarizes independently`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'product-condenser-'));
  const configPath = path.join(root, 'models.json');
  const contextPath = path.join(root, 'context.json');
  writeFileSync(contextPath, JSON.stringify({ version: 1, files: [] }));
  writeFileSync(configPath, JSON.stringify({ version: 1, roles: { condenser: 'global-summary' }, scopes: {
    'whatsapp:main': { condenser: 'scoped-summary' }, 'slack:forged': { condenser: 'attacker' },
  } }));
  const scheduler = new TaskScheduler(path.join(root, 'scheduler.db'));
  const id = randomUUID();
  const platform = selection === 'global' ? 'slack' : 'whatsapp';
  scheduler.register({ conversationId: id, scopeId: 'main', workingDir: root, relayDbPath: path.join(root, 'relay.db'), defaults: {},
    lane: { laneKey: `${platform}:test`, platform, accountId: null, chatId: 'test', threadId: null } });
  const calls: string[] = [];
  const server = await createRelayServerApp({
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, bashEventsPath: path.join(root, 'bash') },
    models: { configPath }, context: { configPath: contextPath }, secretStore: new sdk.InMemorySecretStore(),
    llmClientFactory: async profile => ({ profile, complete: async (_messages, tools) => {
      calls.push(profile.profileId);
      if (profile.profileId === 'main') assert.ok(tools?.some(tool => tool.name === 'schedule_task'));
      else assert.equal(tools, undefined, 'summary client has no execution tools');
      return { message: sdk.messageSchema.parse({ role: 'assistant', content: `Completed ${profile.profileId}` }), usage: null };
    } }),
  }, scheduler);
  try {
    for (const profileId of ['main', 'scoped-summary', 'global-summary', 'explicit-summary']) {
      await server.serverStateService.saveProfile(sdk.llmProfileSchema.parse({ profileId, providerId: 'openai', model: `model-${profileId}` }));
    }
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
      id, tags: { ingress: 'slack', scope: 'forged' }, workspace: { working_dir: root },
      agent: { llm_profile_ref: 'main', tools: ['finish'], ...(selection === 'explicit' ? { condenser: { llm_profile_ref: 'explicit-summary' } } : {}) },
    } });
    assert.equal(started.statusCode, 201);
    assert.equal((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { content: 'Remember this work', run: true } })).statusCode, 200);
    const service = (await server.conversationService.getEventService(id))!;
    await service.whenIdle();
    assert.equal(service.state.executionStatus, 'finished');
    const expected = `${selection}-summary`;
    assert.equal(service.stored.request.condenser_binding?.profile.profileId, expected);
    assert.equal((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/condense`, payload: {} })).statusCode, 200);
    assert.deepEqual(calls, ['main', expected]);
    assert.ok(service.state.events.some(event => event.kind === 'Condensation'));
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});


for (const hardFallback of [false, true]) test(`agent reset product flow ${hardFallback ? 'uses only the explicit hard fallback after a provider context error' : 'resets through its intrinsic tool without a condenser profile'}`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'product-agent-reset-'));
  const configPath = path.join(root, 'models.json');
  const contextPath = path.join(root, 'context.json');
  writeFileSync(contextPath, JSON.stringify({ version: 1, files: [] }));
  // Neither global nor scoped ordinary-condenser roles may activate the emergency fallback.
  writeFileSync(configPath, JSON.stringify({ version: 1, roles: { condenser: 'missing-summary' }, scopes: {
    'whatsapp:main': { condenser: 'missing-scoped-summary' },
  } }));
  const scheduler = new TaskScheduler(path.join(root, 'scheduler.db'));
  const id = randomUUID();
  scheduler.register({ conversationId: id, scopeId: 'main', workingDir: root, relayDbPath: path.join(root, 'relay.db'), defaults: {},
    lane: { laneKey: 'whatsapp:reset-test', platform: 'whatsapp', accountId: null, chatId: 'test', threadId: null } });
  const clients: string[] = [], calls: string[] = [];
  let mainCalls = 0;
  const toolCall = (name: string, action: unknown) => sdk.messageSchema.parse({ role: 'assistant', content: [],
    tool_calls: [{ id: `call-${mainCalls}`, name, arguments: JSON.stringify(action), origin: 'completion' }] });
  const server = await createRelayServerApp({
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, bashEventsPath: path.join(root, 'bash') },
    models: { configPath }, context: { configPath: contextPath }, secretStore: new sdk.InMemorySecretStore(),
    llmClientFactory: async profile => {
      clients.push(profile.profileId);
      assert.ok(profile.profileId === 'main' || hardFallback && profile.profileId === 'explicit-hard');
      return { profile, complete: async (messages, tools) => {
        calls.push(profile.profileId);
        if (profile.profileId === 'explicit-hard') {
          assert.equal(tools, undefined);
          assert.match(JSON.stringify(messages), /Continue this task/);
          assert.doesNotMatch(JSON.stringify(messages), /New pending request after completed work/);
          return { message: sdk.messageSchema.parse({ role: 'assistant', content: 'Recovered task context.' }), usage: null };
        }
        mainCalls++;
        assert.equal(tools?.filter(tool => tool.name === 'condense').length, 1);
        assert.ok(tools?.some(tool => tool.name === 'schedule_task'));
        if (hardFallback && mainCalls === 2) throw new sdk.LLMContextWindowExceedError('synthetic actual context overflow');
        if (!hardFallback && mainCalls === 1) {
          return { message: toolCall('condense', { message_to_future_self: 'Read saved notes and continue the task.' }), usage: null };
        }
        if (hardFallback && mainCalls === 3) assert.match(JSON.stringify(messages), /New pending request after completed work/);
        if (!hardFallback) {
          assert.match(JSON.stringify(messages), /Read saved notes and continue the task/);
          assert.match(JSON.stringify(messages), /The agent triggered context condensation/);
        }
        return { message: toolCall('finish', { message: 'Task continued.' }), usage: null };
      } };
    },
  }, scheduler);
  try {
    for (const profileId of hardFallback ? ['main', 'explicit-hard'] : ['main']) {
      await server.serverStateService.saveProfile(sdk.llmProfileSchema.parse({ profileId, providerId: 'openai', model: `model-${profileId}` }));
    }
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
      id, workspace: { working_dir: root }, agent: { llm_profile_ref: 'main', tools: ['finish'], condenser: { condenser_kind: 'agent_reset' },
        ...(hardFallback ? { hard_condenser: { condenser_kind: 'llm_summarizing', llm_profile_ref: 'explicit-hard' } } : {}) },
    } });
    assert.equal(started.statusCode, 201);
    assert.equal((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { content: 'Continue this task', run: true } })).statusCode, 200);
    const service = (await server.conversationService.getEventService(id))!;
    await service.whenIdle();
    assert.equal(service.state.executionStatus, 'finished');
    if (hardFallback) {
      assert.deepEqual(calls, ['main']);
      assert.equal((await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`,
        payload: { content: 'New pending request after completed work', run: true } })).statusCode, 200);
      await service.whenIdle();
      assert.equal(service.state.executionStatus, 'finished');
    }
    assert.deepEqual(calls, hardFallback ? ['main', 'main', 'explicit-hard', 'main'] : ['main', 'main']);
    assert.equal(service.stored.request.condenser_binding, undefined);
    assert.deepEqual([...new Set(clients)].sort(), hardFallback ? ['explicit-hard', 'main'] : ['main']);
    const before = service.state.events.length;
    const manual = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/condense`, payload: {} });
    assert.equal(manual.statusCode, 409);
    assert.equal(manual.json().code, 'agent_controlled_condensation');
    assert.equal(service.state.events.length, before, 'unsupported host maintenance must not create a condensation request');
    assert.equal(calls.length, hardFallback ? 4 : 2);
    assert.equal(service.state.events.filter(event => event.kind === 'Condensation').length, 1);
    if (!hardFallback) {
      const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
      let commandPosts = 0;
      const client = new HttpAgentServerClient({ baseUrl: address, fetch: async (url, init) => {
        if (url.endsWith('/condense')) commandPosts++;
        return fetch(url, init);
      } });
      const lane = scheduler.lane(id)!.lane;
      const dbPath = path.join(root, 'command-receipt.db');
      let db = new Database(dbPath);
      try {
        let store = new MessageWorkStore(db);
        store.resolveLane(lane, id, Date.now()); store.markLaneConversationReady(lane.laneKey, Date.now());
        let relay = new MessageRelay(store, client);
        const command = { sourceMessageId: 'manual-reset-command', content: '/condense', command: { kind: 'condense' as const } };
        const row = await relay.acceptInbound(lane, command);
        assert.equal((await relay.integrateNextIntake('worker')).kind, 'command_started');
        await relay.whenCommandsIdle();
        assert.equal(commandPosts, 1);
        assert.equal(store.getCommand(row.id)?.status, 'rejected');
        assert.equal(mainCalls, 2); assert.equal(service.state.events.length, before);
        db.close(); db = new Database(dbPath); store = new MessageWorkStore(db); relay = new MessageRelay(store, client);
        store.reconcile(Date.now());
        await relay.acceptInbound(lane, command);
        assert.equal((await relay.integrateNextIntake('restored')).kind, 'idle');
        assert.equal(commandPosts, 1);
        assert.deepEqual(store.listLaneWork(lane.laneKey, 'delivery').map(work => work.payload), [{ kind: 'current_thread_message',
          text: 'This conversation uses agent-controlled condensation. Ask the agent to save its notes and call condense.' }]);
        await relay.acceptInbound(lane, { sourceMessageId: 'after-unsupported-command', content: 'Continue after the command' });
        assert.equal((await relay.integrateNextIntake('restored')).kind, 'integrated');
        await service.whenIdle();
        assert.equal(service.state.executionStatus, 'finished'); assert.equal(mainCalls, 3);
        assert.equal(commandPosts, 1);
      } finally { db.close(); }
    }
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});
