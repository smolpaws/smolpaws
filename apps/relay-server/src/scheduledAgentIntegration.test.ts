import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pino from 'pino';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { RelayRuntime } from '../../../src/coordinator/relayRuntime.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
import { createRelayServerApp } from './app.js';
import type { SlackCheckerPort } from './scheduledAgentTools.js';
const sdk = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;
const call = (name: string, args: unknown) => sdk.messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: `${name}-${Math.random()}`, name, arguments: JSON.stringify(args), origin: 'completion' }] });

for (const mode of ['disabled', 'llm_summarizing', 'agent_reset'] as const)
for (const activity of [false, true]) test(`${mode} isolated checker gets lean context and exact tools; ${activity ? 'handoff reaches full owner and WhatsApp' : 'quiet completion sends nothing'}`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'slack-checker-integration-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const configPath = path.join(root, 'scheduled-agents.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, tasks: {} }));
  const contextConfig = path.join(root, 'context.json');
  writeFileSync(path.join(root, 'memory.md'), 'FULL_SMOLPAWS_MEMORY_MARKER');
  writeFileSync(path.join(root, 'checker.md'), 'LEAN_SLACK_CHECKER_MARKER. Use Chrome. Engel uses Comet.');
  writeFileSync(contextConfig, JSON.stringify({ version: 1, files: ['memory.md'] }));
  const schedulerPath = path.join(root, 'scheduler.db');
  const relayPath = path.join(root, 'relay.db');
  const scheduler = new TaskScheduler(schedulerPath);
  const sourceIds = ['TTEST:CTEST:100.001'];
  let pending = activity ? sourceIds.slice() : [];
  let checks = 0, acknowledgements = 0;
  const checker: SlackCheckerPort = {
    async check() { checks++; return activity ? { status: 'activity', source_ids: sourceIds, items: [], followed_threads: 1 } : { status: 'quiet', followed_threads: 1 }; },
    async recover() { assert.fail('normal checks must not recover Chrome'); },
    pendingSourceIds() { return pending; },
    async acknowledge(ids) { assert.deepEqual(ids, sourceIds); pending = []; acknowledgements++; },
  };
  const requests: Array<{ profile: string; system: string; tools: string[] }> = [];
  const condenser = mode === 'disabled' ? { enabled: false } : mode === 'agent_reset'
    ? { condenser_kind: 'agent_reset' } : { condenser_kind: 'llm_summarizing', llm_profile_ref: 'summary' };
  const server = await createRelayServerApp({
    scheduledAgents: { configPath }, slackCheckerFactory: () => checker,
    context: { configPath: contextConfig }, models: { homeDir: root },
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), bashEventsPath: path.join(root, 'bash'), workspaceRoot: workspace },
    secretStore: new sdk.InMemorySecretStore(),
    llmClientFactory: async profile => {
      const helper = profile.profileId === 'cheap-checker';
      const llm = sdk.TestLLM.fromMessages(helper ? [call('check_slack', {}), ...(activity ? [call('notify_smolpaws', { message: 'Slack needs attention: https://app.slack.com/archives/CTEST/p100001', source_ids: sourceIds }), call('notify_smolpaws', { message: 'Retry after lost observation: same Slack activity', source_ids: sourceIds })] : []), call('finish', { message: '' })] : [call('finish', { message: 'initial reply' }), call('finish', { message: 'handled Slack activity' })], { profile });
      return { profile, async complete(messages, tools) {
        assert.notEqual(profile.profileId, 'summary', 'small scheduled runs must not call the summarizer');
        requests.push({ profile: profile.profileId, system: messages.filter(m => m.role === 'system').flatMap(m => m.content).filter(c => c.type === 'text').map(c => c.text).join('\n'), tools: tools?.map(t => t.name) ?? [] });
        return llm.complete(messages);
      } };
    },
  }, scheduler);
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const deliveries: Array<{ text?: string }> = [];
  const runtime = new RelayRuntime({ platform: 'whatsapp', logger: pino({ level: 'silent' }), serverUrl: address, dbPath: relayPath, schedulerDbPath: schedulerPath,
    createConversationDefaults: { workspace: { working_dir: workspace }, tags: { scope: 'openhands' }, agent: { condenser, llm_profile_ref: 'full-owner' } },
    target: { validate() {}, async deliver(_lane, payload) { deliveries.push(payload as { text?: string }); return {}; } },
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) { await runtime.runOnce(); if (condition()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
    assert.fail('relay did not reach expected state');
  };
  try {
    for (const id of ['full-owner', 'cheap-checker', 'summary']) assert.equal((await server.app.inject({ method: 'POST', url: '/api/profiles', payload: { profileId: id, providerId: 'openai', model: 'fixture' } })).statusCode, 201);
    const lane = { laneKey: 'whatsapp:test-openhands', platform: 'whatsapp', accountId: 'account', chatId: 'group', threadId: null };
    await runtime.accept({ lane, message: { sourceMessageId: 'initial', content: 'Initial owner message' } });
    await until(() => deliveries.some(d => d.text === 'initial reply'));
    const owner = runtime.workStore.getLane(lane.laneKey)!.conversationId;
    const result = scheduler.execute(owner, 'schedule_task', { prompt: 'Check Slack, notify SmolPaws when needed, and finish silently.', schedule_type: 'once', schedule_value: new Date(Date.now() - 1).toISOString(), context_mode: 'isolated' }, 'create-checker');
    assert.equal(result.is_error, false);
    const taskId = JSON.parse(result.text).task_id as string;
    const expectedTools = ['terminal', 'check_slack', 'recover_slack', 'notify_smolpaws', 'finish'];
    writeFileSync(configPath, JSON.stringify({ version: 1, tasks: { [taskId]: { profile: 'cheap-checker', context_files: ['checker.md'], tools: expectedTools,
      slack: { workspace_id: 'TTEST', user_id: 'UTEST', workspace_url: 'https://app.slack.com/client/TTEST', state_dir: 'slack' } } } }));
    await until(() => (scheduler.db.prepare('SELECT status FROM scheduler_tasks WHERE id=?').get(taskId) as { status: string }).status === 'completed' && (!activity || deliveries.some(d => d.text === 'handled Slack activity')));
    await runtime.runOnce();
    assert.equal(checks, 1); assert.equal(acknowledgements, activity ? 2 : 0);
    assert.deepEqual(deliveries.map(d => d.text), activity ? ['initial reply', 'handled Slack activity'] : ['initial reply']);
    const helperRequests = requests.filter(r => r.profile === 'cheap-checker'); assert.equal(helperRequests.length, activity ? 4 : 2);
    for (const request of helperRequests) { assert.deepEqual(request.tools, mode === 'agent_reset' ? [...expectedTools, 'condense'] : expectedTools); assert.match(request.system, /LEAN_SLACK_CHECKER_MARKER/); assert.doesNotMatch(request.system, /FULL_SMOLPAWS_MEMORY_MARKER/); }
    for (const request of requests.filter(r => r.profile === 'full-owner')) { assert.match(request.system, /FULL_SMOLPAWS_MEMORY_MARKER/); assert.ok(!request.tools.includes('notify_smolpaws')); }
    if (activity) {
      const events = (await (await server.conversationService.getEventService(owner))!.searchEvents()).items;
      assert.ok(events.some(e => e.kind === 'MessageEvent' && e.llm_message.role === 'user' && JSON.stringify(e.llm_message.content).includes('Slack needs attention')));
    }
  } finally { await runtime.stop(); await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});
