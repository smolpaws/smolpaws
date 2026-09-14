import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { createRelayServerApp } from './app.js';
import { RelayRuntime } from '../../../src/coordinator/relayRuntime.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const { TestLLM, InMemorySecretStore, messageSchema } = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;
const call = (name: string, args: object) => messageSchema.parse({ role: 'assistant' as const, content: [], tool_calls: [{ id: name, name, arguments: JSON.stringify(args), origin: 'completion' as const }] });

for (const platform of ['whatsapp', 'slack', 'discord', 'agent-server']) test(`${platform}: profile tools create a real task, return observations, and deliver its scheduled run`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'product-relay-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'voice.ogg'), 'test media bytes');
  const schedulerPath = path.join(root, 'scheduler.db');
  let created = 0;
  const { app, scheduler } = await createRelayServerApp({
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: workspace, sessionApiKey: 'test' },
    secretStore: new InMemorySecretStore(),
    llmClientFactory: async () => TestLLM.fromMessages(++created === 1 ? [
      call('schedule_task', { prompt: 'scheduled hello', schedule_type: 'once', schedule_value: new Date(Date.now() + 600).toISOString(), context_mode: 'isolated' }),
      call('list_tasks', {}),
      ...(platform === 'agent-server' ? [] : [call('send_media', { path: 'voice.ogg', media_type: 'audio', voice_note: true })]),
      call('finish', { message: 'scheduled' }),
    ] : [call('finish', { message: 'task result' })]),
  }, new TaskScheduler(schedulerPath));
  const headers = { 'x-session-api-key': 'test' };
  const profile = { profileId: 'test', providerId: 'openai', model: 'test', openAiApiMode: 'responses' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/profiles', headers, payload: profile })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/api/profiles/test/activate', headers })).statusCode, 200);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const deliveries: unknown[] = [];
  const runtime = new RelayRuntime({ platform, logger: pino({ level: 'silent' }), serverUrl: address, sessionApiKey: 'test',
    dbPath: path.join(root, platform === 'agent-server' ? 'agent-server-relay-v1.db' : 'relay.db'), schedulerDbPath: schedulerPath,
    createConversationDefaults: { workspace: { working_dir: workspace }, tags: { scope: 'main' } },
    target: { validate() {}, async deliver(_lane, payload) { deliveries.push(payload); return { externalMessageId: 'fake' }; } }, tickMs: 60_000 });
  const lane = { laneKey: `${platform}:test`, platform, accountId: 'account', chatId: 'chat', threadId: null };
  try {
    if (platform === 'agent-server') {
      const response = await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {
        workspace: { working_dir: workspace }, tags: { scope: 'main' }, initial_message: { role: 'user', content: 'schedule something', run: true },
      } });
      assert.equal(response.statusCode, 201);
    } else await runtime.accept({ lane, message: { sourceMessageId: 'inbound', content: 'schedule something' } });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await runtime.runOnce();
      const task = scheduler.db.prepare('SELECT status FROM scheduler_tasks').get() as { status: string } | undefined;
      if (task?.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const task = scheduler.db.prepare('SELECT * FROM scheduler_tasks').get() as { status: string; last_result: string };
    assert.equal(task.status, 'completed'); assert.equal(task.last_result, 'task result');
    assert.equal((scheduler.db.prepare('SELECT COUNT(*) AS n FROM scheduler_tasks').get() as { n: number }).n, 1);
    if (platform === 'agent-server') assert.match((scheduler.db.prepare('SELECT scope_id FROM scheduler_tasks').get() as { scope_id: string }).scope_id, /^agent-server:/);
    if (platform !== 'agent-server') {
      const media = deliveries.find(p => (p as { kind?: string }).kind === 'current_thread_media') as { path: string; voiceNote: boolean };
      assert.equal(media.voiceNote, true); assert.equal(readFileSync(media.path, 'utf8'), 'test media bytes');
    }
    await runtime.runOnce();
    assert.equal(deliveries.filter(p => (p as { text?: string }).text === 'task result').length, 1);
  } finally { await runtime.stop(); await app.close(); rmSync(root, { recursive: true, force: true }); }
});
