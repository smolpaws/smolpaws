import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { createRelayServerApp } from './app.js';

const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

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
