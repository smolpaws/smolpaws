import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { createRelayServerApp } from './app.js';

const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

function systemPrompt(messages: readonly Sdk.Message[]): string {
  return messages.filter(message => message.role === 'system').flatMap(message => message.content)
    .flatMap(content => content.type === 'text' ? [content.text] : []).join('\n');
}

test('product host loads full scoped memory before the first completion and restores its snapshot after source changes and deletion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-context-integration-'));
  const repoRoot = path.join(root, 'repo');
  const docs = path.join(repoRoot, 'docs', 'smolpaws');
  const memoryFile = path.join(root, 'MEMORY.md');
  const configPath = path.join(root, 'context.json');
  const schedulerPath = path.join(root, 'scheduler.db');
  const identity = 'You are SmolPaws, a helpful tiny cat. Integration identity marker.';
  const memory = `# MEMORY.md\n${'Full durable memory row.\n'.repeat(2200)}last durable memory row`;
  assert.ok(memory.length > 49_000);
  const requests: Array<readonly Sdk.Message[]> = [];
  let server: Awaited<ReturnType<typeof createRelayServerApp>> | undefined;
  const open = async () => createRelayServerApp({
    context: { configPath, repoRoot, homeDir: root },
    models: { homeDir: root },
    config: {
      conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
      bashEventsPath: path.join(root, 'bash'), workspaceRoot: repoRoot,
    },
    secretStore: new sdk.InMemorySecretStore(),
    llmClientFactory: async profile => {
      const llm = sdk.TestLLM.fromMessages([sdk.messageSchema.parse({ role: 'assistant', content: [],
        tool_calls: [{ id: `finish-${requests.length}`, name: 'finish', arguments: JSON.stringify({ message: 'Context available.' }), origin: 'completion' }],
      })], { profile });
      return { profile, complete: async (messages: readonly Sdk.Message[]) => { requests.push(messages); return llm.complete(messages); } };
    },
  }, new TaskScheduler(schedulerPath));
  const finishTurn = async (id: string) => {
    assert.ok(server);
    const sent = await server.app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: 'Use the context already provided and finish.', run: true } });
    assert.equal(sent.statusCode, 200);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const info = (await server.app.inject(`/api/conversations/${id}`)).json<{ execution_status: string }>();
      assert.notEqual(info.execution_status, 'error', 'context loading must not fail on restore');
      if (info.execution_status === 'finished') return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Conversation did not finish');
  };
  try {
    await mkdir(docs, { recursive: true });
    await writeFile(path.join(docs, 'SOUL.md'), identity);
    await writeFile(memoryFile, memory);
    await writeFile(configPath, JSON.stringify({ version: 1, scopes: { 'whatsapp:main': ['MEMORY.md'] } }));
    server = await open();
    const profile = { profileId: 'context-integration', providerId: 'openai', model: 'test-model' };
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/profiles', payload: profile })).statusCode, 201);
    const started = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {
      agent: { condenser: { enabled: false }, llm_profile_ref: profile.profileId, tools: ['finish'] }, workspace: { working_dir: repoRoot },
      agent_launch_additions: { system_message_suffix_append: 'Keep this additional launch instruction.' },
    } });
    assert.equal(started.statusCode, 201);
    const id = started.json<{ id: string }>().id;
    // The trusted bridge registration, not request tags, selects the scoped file.
    server.scheduler.register({ conversationId: id, scopeId: 'main', workingDir: repoRoot, defaults: {},
      relayDbPath: path.join(root, 'relay.db'),
      lane: { laneKey: 'whatsapp:test-main', platform: 'whatsapp', accountId: null, chatId: 'test-main', threadId: null },
    });
    await finishTurn(id);
    assert.equal(requests.length, 1);
    const firstPrompt = systemPrompt(requests[0]!);
    assert.ok(firstPrompt.includes(memory), 'the first completion receives the complete memory body');
    assert.ok(firstPrompt.includes(identity));
    assert.ok(firstPrompt.includes('Keep this additional launch instruction.'));
    assert.match(firstPrompt, /<REPO_CONTEXT>/);
    assert.match(firstPrompt, /whatsapp bridge/);
    assert.equal(requests[0]!.filter(message => message.role === 'tool' || message.role === 'assistant').length, 0, 'context is available before any read-file tool step');
    const snapshotPath = path.join(root, 'conversations', id, 'smolpaws-context.json');
    const originalSnapshot = await readFile(snapshotPath, 'utf8');
    const snapshot = JSON.parse(originalSnapshot) as { scope: string; files: Array<{ content: string }> };
    assert.equal(snapshot.scope, 'whatsapp:main');
    assert.deepEqual(snapshot.files.map(file => file.content), [identity, memory]);

    await server.app.close(); server = undefined;
    await writeFile(memoryFile, 'Changed memory must not replace the conversation snapshot.');
    await writeFile(path.join(docs, 'SOUL.md'), 'Changed identity must not replace the conversation snapshot.');
    await writeFile(configPath, JSON.stringify({ version: 1, files: [], scopes: {} }));
    server = await open();
    assert.equal(server.scheduler.lane(id)?.scopeId, 'main');
    await finishTurn(id);
    assert.equal(requests.length, 2);
    assert.ok(systemPrompt(requests[1]!).includes(memory));
    assert.ok(systemPrompt(requests[1]!).includes(identity));
    assert.ok(!systemPrompt(requests[1]!).includes('Changed memory'));

    await server.app.close(); server = undefined;
    await rm(memoryFile); await rm(configPath); await rm(docs, { recursive: true });
    server = await open();
    await finishTurn(id);
    assert.equal(requests.length, 3);
    assert.ok(systemPrompt(requests[2]!).includes(memory));
    assert.ok(systemPrompt(requests[2]!).includes(identity));
    assert.equal(await readFile(snapshotPath, 'utf8'), originalSnapshot);
    const events = (await (await server.conversationService.getEventService(id))!.searchEvents()).items;
    assert.deepEqual(events.filter(event => event.kind === 'ActionEvent').map(event => event.tool_name), ['finish', 'finish', 'finish']);
  } finally {
    await server?.app.close();
    await rm(root, { recursive: true, force: true });
  }
});
