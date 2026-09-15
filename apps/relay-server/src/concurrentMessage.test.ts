import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRelayServerApp } from './app.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const { OpenAIChatClient, InMemorySecretStore } = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

test('user input during a running tool stays durable and produces valid provider history, including after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'concurrent-message-'));
  const conversationId = randomUUID(); const userId = randomUUID();
  let calls = 0;
  const requests: Array<Array<{role:string;tool_calls?:Array<{id:string}>;tool_call_id?:string}>> = [];
  const options = {
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, sessionApiKey: 'test' },
    secretStore: new InMemorySecretStore(),
    llmClientFactory: async (profile: Sdk.LLMProfile) => new OpenAIChatClient(profile, 'test', async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.messages);
      const pending = new Set<string>();
      for (const m of body.messages) {
        if (m.role !== 'tool' && pending.size) return { ok: false, status: 400, text: async () => 'tool result must precede concurrent user message', json: async () => ({}) };
        if (m.role === 'assistant') for (const t of m.tool_calls ?? []) pending.add(t.id);
        if (m.role === 'tool') pending.delete(m.tool_call_id);
      }
      const message = calls++ === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'slow-call', type: 'function', function: { name: 'terminal', arguments: JSON.stringify({ command: 'printf once >> effect.txt; sleep 0.4', timeout: 5 }) } }] }
        : { role: 'assistant', content: 'Finished after receiving the concurrent message.' };
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message }] }) };
    }),
  };
  let server = await createRelayServerApp(options, new TaskScheduler(path.join(root, 'scheduler.db')));
  const headers = { 'x-session-api-key': 'test' };
  const events = async () => (await server.app.inject({ url: `/api/conversations/${conversationId}/events/search`, headers })).json().items as Array<Record<string, unknown>>;
  const wait = async (predicate: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail('timed out waiting for conversation');
  };
  try {
    await server.app.inject({ method: 'POST', url: '/api/profiles', headers, payload: { profileId: 'test', providerId: 'openai', model: 'test', openAiApiMode: 'chat_completions' } });
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
      conversation_id: conversationId, agent: { agent_kind: 'openhands', llm_profile_ref: 'test' }, workspace: { working_dir: root },
      initial_message: { role: 'user', content: 'Run the tool.', run: true }, max_iterations: 8,
    } }); assert.equal(started.statusCode, 201, started.body);
    await wait(async () => (await events()).some(e => e.kind === 'ActionEvent'));
    const accepted = await server.app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/events`, headers,
      payload: { role: 'user', content: 'Please include the result.', event_id: userId, run: true } });
    assert.equal(accepted.statusCode, 200); assert.equal(accepted.json().created, true);
    await wait(async () => ['finished','error'].includes((await server.app.inject({ url: `/api/conversations/${conversationId}`, headers })).json().execution_status));
    const info = (await server.app.inject({ url: `/api/conversations/${conversationId}`, headers })).json();
    assert.equal(info.execution_status, 'finished', 'provider rejected the interleaved message history');
    const logged = await events();
    assert.ok(logged.findIndex(e => e.id === userId) < logged.findIndex(e => e.kind === 'ObservationEvent'), 'original arrival order remains durable');
    assert.equal(readFileSync(path.join(root, 'effect.txt'), 'utf8'), 'once');
    await server.app.close();
    server = await createRelayServerApp(options, new TaskScheduler(path.join(root, 'scheduler.db')));
    const resumed = await server.app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/events`, headers,
      payload: { role: 'user', content: 'Continue after restart.', run: true } }); assert.equal(resumed.statusCode, 200);
    await wait(async () => ['finished','error'].includes((await server.app.inject({ url: `/api/conversations/${conversationId}`, headers })).json().execution_status));
    assert.equal((await server.app.inject({ url: `/api/conversations/${conversationId}`, headers })).json().execution_status, 'finished');
    assert.equal(readFileSync(path.join(root, 'effect.txt'), 'utf8'), 'once', 'restart must not repeat the completed tool');
    assert.ok(requests.length >= 3);
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});
