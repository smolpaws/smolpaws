import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRelayServerApp } from './app.js';
import { registerWebhookBridges } from './webhookBridges.js';
import { TaskScheduler } from '../../../src/coordinator/taskScheduler.js';
import { dispatchToAgentServer } from '../../github/src/agentServerClient.js';
import { dispatchEmailToAgentServer } from '../../email/src/agentDispatch.js';
import type * as Sdk from '../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.js';
const { TestLLM, InMemorySecretStore, messageSchema } = createRequire(import.meta.url)('../../../packages/openhands-agent-server/vendor/openhands-agent/dist/index.cjs') as typeof Sdk;

// External services are substituted at the final network boundary; intake, SQLite,
// scheduling, HTTP, agent execution and delivery fencing use the real implementations.
test('Workers hand off durable intake; host delivers once across duplicate submissions and restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'webhook-relay-'));
  mkdirSync(path.join(root, 'mapped-repo'));
  writeFileSync(path.join(root, 'repo-map.json'), JSON.stringify({ 'owner/repo': 'mapped-repo' }));
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = { GITHUB_USER_TOKEN: 'github-test-token', GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'), SMOLPAWS_WORKSPACE_ROOT: root, SMOLPAWS_REPO_MAP_PATH: path.join(root, 'repo-map.json'), RESEND_API_KEY: 'resend-test-key', EMAIL_FROM_ADDRESS: 'cat@example.com' };
  let tokenAttempts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/access_tokens')) {
      if (++tokenAttempts === 1) throw new Error('Token endpoint temporarily unavailable');
      assert.equal(String(input), 'https://api.github.com/app/installations/456/access_tokens');
      assert.match(new Headers(init?.headers).get('authorization') ?? '', /^Bearer ey/);
      return new Response(JSON.stringify({ token: 'installation-token' }));
    }
    const auth = new Headers(init?.headers).get('authorization');
    if (String(input).includes('api.github.com')) assert.match(auth ?? '', /^Bearer (installation-token|github-test-token)$/);
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: 'delivery-1' }), { status: 201 });
  };
  const create = async () => {
    const call = messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: randomUUID(), name: 'finish', arguments: JSON.stringify({ message: 'done' }), origin: 'completion' }] });
    const { app } = await createRelayServerApp({ config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, sessionApiKey: 'session' },
      secretStore: new InMemorySecretStore(), llmClientFactory: async () => TestLLM.fromMessages([call]),
      context: { homeDir: root }, models: { homeDir: root },
    }, new TaskScheduler(path.join(root, 'scheduler.db')));
    registerWebhookBridges(app, { sessionApiKey: 'session', dbDirectory: root, schedulerDbPath: path.join(root, 'scheduler.db'), env, fetcher, tickMs: 20,
      createConversationDefaults: { agent: { agent_kind: 'openhands', llm_profile_ref: 'test', condenser: { enabled: false } }, workspace: { kind: 'LocalWorkspace', working_dir: root } } });
    await app.inject({ method: 'POST', url: '/api/profiles', headers: { 'x-session-api-key': 'session' }, payload: { profileId: 'test', providerId: 'openai', model: 'test', openAiApiMode: 'responses' } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, clientEnv: { SMOLPAWS_RELAY_SERVER_URL: address, SMOLPAWS_RELAY_SERVER_API_KEY: 'session' } };
  };
  const github = { event: 'issue_comment' as const, delivery_id: 'gh-123', payload: { repository: { full_name: 'owner/repo' }, issue: { number: 7 }, comment: { body: '@smolpaws do the thing' }, installation: { id: 456 } } };
  const email = { emailId: 'email-123', sender: 'human@example.com', subject: 'hello', text: 'do the thing', messageId: '<original@example.com>' };
  let server = await create();
  try {
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/bridges/github/messages', payload: {} })).statusCode, 401);
    assert.equal((await server.app.inject({ method: 'POST', url: '/api/bridges/github/messages', headers: { 'x-session-api-key': 'session' }, payload: {} })).statusCode, 400);
    await Promise.all([dispatchToAgentServer(github, server.clientEnv), dispatchToAgentServer(github, server.clientEnv)]);
    await dispatchEmailToAgentServer(email, server.clientEnv);
    const mismatch = await server.app.inject({ method: 'POST', url: '/api/bridges/email/messages', headers: { 'x-session-api-key': 'session' }, payload: { ...email, sender: 'other@example.com' } });
    assert.equal(mismatch.statusCode, 409);
    for (let n = 0; n < 500 && sent.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, 2);
    const conversations = (await server.app.inject({ url: '/api/conversations/search', headers: { 'x-session-api-key': 'session' } })).json();
    assert.ok(JSON.stringify(conversations).includes('mapped-repo'));
    assert.ok(tokenAttempts >= 2);
    const gh = sent.find(item => item.url.includes('api.github.com'))!;
    assert.equal(gh.url, 'https://api.github.com/repos/owner/repo/issues/7/comments');
    assert.match(String(gh.body.body), /done/); assert.match(String(gh.body.body), /AI agent/);
    const mail = sent.find(item => item.url.includes('api.resend.com'))!;
    assert.deepEqual(mail.body.to, ['human@example.com']); assert.equal(mail.body.subject, 'Re: hello');
    assert.equal((mail.body.headers as Record<string, string>)['In-Reply-To'], '<original@example.com>');
    await dispatchToAgentServer({ ...github, delivery_id: 'notification-456', payload: { ...github.payload, installation: undefined } }, server.clientEnv);
    for (let n = 0; n < 250 && sent.length < 3; n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, 3);
    await server.app.close(); server = await create();
    await dispatchToAgentServer(github, server.clientEnv); await dispatchEmailToAgentServer({ ...email, subject: 'must not replace original metadata' }, server.clientEnv);
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(sent.length, 3);
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an ambiguous GitHub send is parked and never automatically repeated after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'webhook-unknown-'));
  let attempts = 0;
  const create = async () => {
    const { app } = await createRelayServerApp({ config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, sessionApiKey: 'session' },
      secretStore: new InMemorySecretStore(), context: { homeDir: root }, models: { homeDir: root },
      llmClientFactory: async () => TestLLM.fromMessages([messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: randomUUID(), name: 'finish', arguments: JSON.stringify({ message: 'done' }), origin: 'completion' }] })]),
    }, new TaskScheduler(path.join(root, 'scheduler.db')));
    registerWebhookBridges(app, { sessionApiKey: 'session', dbDirectory: root, schedulerDbPath: path.join(root, 'scheduler.db'), tickMs: 20, env: { GITHUB_USER_TOKEN: 'test', SMOLPAWS_WORKSPACE_ROOT: root },
      fetcher: async () => { attempts++; throw new Error('Connection lost after sending'); },
      createConversationDefaults: { agent: { agent_kind: 'openhands', llm_profile_ref: 'test', condenser: { enabled: false } }, workspace: { kind: 'LocalWorkspace', working_dir: root } } });
    await app.inject({ method: 'POST', url: '/api/profiles', headers: { 'x-session-api-key': 'session' }, payload: { profileId: 'test', providerId: 'openai', model: 'test', openAiApiMode: 'responses' } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return { app, env: { SMOLPAWS_RELAY_SERVER_URL: address, SMOLPAWS_RELAY_SERVER_API_KEY: 'session' } };
  };
  const input = { event: 'issue_comment' as const, delivery_id: 'uncertain', payload: { repository: { full_name: 'owner/repo' }, issue: { number: 8 }, comment: { body: 'hello' } } };
  let server = await create();
  try {
    await dispatchToAgentServer(input, server.env);
    for (let i = 0; i < 250 && attempts === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(attempts, 1);
    await server.app.close(); server = await create();
    await dispatchToAgentServer(input, server.env);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(attempts, 1);
  } finally { await server.app.close(); rmSync(root, { recursive: true, force: true }); }
});

test('webhook scheduling shares the host scheduler when relay databases live elsewhere', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'webhook-scheduler-'));
  const scheduler = new TaskScheduler(path.join(root, 'host', 'scheduler.db'));
  const sent: Array<Record<string, unknown>> = [];
  let calls = 0;
  const call = (name: string, args: object) => messageSchema.parse({ role: 'assistant', content: [], tool_calls: [{ id: randomUUID(), name, arguments: JSON.stringify(args), origin: 'completion' }] });
  const { app } = await createRelayServerApp({
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: root, sessionApiKey: 'session' },
    secretStore: new InMemorySecretStore(), context: { homeDir: root }, models: { homeDir: root },
    llmClientFactory: async () => TestLLM.fromMessages(++calls === 1
      ? [call('schedule_task', { prompt: 'Send the follow-up', schedule_type: 'once', schedule_value: new Date(Date.now() - 1).toISOString(), context_mode: 'group' }), call('finish', { message: 'scheduled' }), call('finish', { message: 'follow-up' })]
      : [call('finish', { message: 'follow-up' })]),
  }, scheduler);
  registerWebhookBridges(app, {
    sessionApiKey: 'session', dbDirectory: path.join(root, 'relays'), schedulerDbPath: scheduler.db.name,
    env: { RESEND_API_KEY: 'test', EMAIL_FROM_ADDRESS: 'cat@example.com' }, tickMs: 20,
    fetcher: async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: `sent-${sent.length}` })); },
    createConversationDefaults: { agent: { agent_kind: 'openhands', llm_profile_ref: 'test', condenser: { enabled: false } }, workspace: { kind: 'LocalWorkspace', working_dir: root }, tags: { scope: 'mail-scope' } },
  });
  try {
    await app.inject({ method: 'POST', url: '/api/profiles', headers: { 'x-session-api-key': 'session' }, payload: { profileId: 'test', providerId: 'openai', model: 'test', openAiApiMode: 'responses' } });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    await dispatchEmailToAgentServer({ emailId: 'scheduled-email', sender: 'human@example.com', text: 'Schedule a follow-up' }, { SMOLPAWS_RELAY_SERVER_URL: address, SMOLPAWS_RELAY_SERVER_API_KEY: 'session' });
    for (let n = 0; n < 500 && !sent.some(item => String(item.text).includes('follow-up')); n++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(sent.some(item => String(item.text).includes('follow-up')), 'the webhook worker must drain the host-scheduled occurrence');
    const task = scheduler.db.prepare('SELECT conversation_id, scope_id, status FROM scheduler_tasks').get() as { conversation_id: string; scope_id: string; status: string };
    assert.equal(task.scope_id, 'mail-scope'); assert.equal(task.status, 'completed');
    assert.equal(scheduler.lane(task.conversation_id)?.lane.platform, 'email');
    assert.equal(scheduler.lane(task.conversation_id)?.relayDbPath, path.join(root, 'relays', 'email-relay-v1.db'));
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
