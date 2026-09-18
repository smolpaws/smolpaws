import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRelayServerApp } from './app.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { submitHeartbeat } from '../../agent-server/src/agent-server/heartbeatClient.js';
import { heartbeatRequestHeaders, type HeartbeatConversationRequest } from '../../agent-server/src/agent-server/heartbeat.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const { TestLLM, InMemorySecretStore, messageSchema } = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

test('heartbeat ticks run real product task tools in one saved conversation without retry duplication', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'heartbeat-product-'));
  const call = (name: string, args: object) => messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: randomUUID(), name, arguments: JSON.stringify(args), origin: 'completion' }] });
  const { app } = await createRelayServerApp({
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, sessionApiKey: 'test' },
    secretStore: new InMemorySecretStore(),
    llmClientFactory: async () => TestLLM.fromMessages([call('list_tasks', {}), call('finish', { message: 'first' }), call('list_tasks', {}), call('finish', { message: 'second' })]),
  }, new TaskScheduler(path.join(root, 'scheduler.db')));
  const headers = heartbeatRequestHeaders({ SMOLPAWS_RELAY_SERVER_API_KEY: 'test' });
  const profile = { profileId: 'heartbeat', providerId: 'openai', model: 'test', openAiApiMode: 'responses' };
  await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: profile });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const agent = { agent_kind: 'openhands' as const, llm_profile_ref: 'heartbeat', condenser: { enabled: false } };
  const request: HeartbeatConversationRequest = { conversation_id: randomUUID(), agent,
    workspace: { kind: 'LocalWorkspace', working_dir: root }, max_iterations: 10, initial_message: { role: 'user', content: 'List tasks and finish. Do not send messages.' } };
  const events = async () => (await app.inject({ url: `/api/conversations/${request.conversation_id}/events/search`, headers: { 'x-session-api-key': 'test' } })).json().items as Array<Record<string, unknown>>;
  const waitForFinish = async (count: number) => {
    for (let n = 0; n < 100; n++) {
      const list = await events();
      if (list.filter(e => e.kind === 'ObservationEvent' && e.tool_name === 'finish').length === count) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('heartbeat did not finish');
  };
  try {
    const now = new Date('2026-09-15T12:00:00Z');
    await submitHeartbeat(address, request, headers, now); await waitForFinish(1);
    await submitHeartbeat(address, request, headers, now);
    const later = new Date('2026-09-15T13:00:00Z');
    await submitHeartbeat(address, request, headers, later); await waitForFinish(2);
    const list = await events();
    assert.equal(list.filter(e => e.kind === 'MessageEvent' && e.source === 'user').length, 2);
    const observations = list.filter(e => e.kind === 'ObservationEvent' && e.tool_name === 'list_tasks');
    assert.equal(observations.length, 2);
    assert.equal(list.filter(e => e.kind === 'AgentErrorEvent').length, 0);
    assert.ok(observations.every(e => !JSON.stringify(e).includes('Missing durable action identity')));
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
