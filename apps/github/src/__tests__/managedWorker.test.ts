import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import worker from '../index.js';
import { managedHttp, type ManagedEnv } from '../managedAgents/worker.js';
import { managedAgentTools } from '../managedAgents/client.js';
import { createGithubGateway } from '../managedAgents/github.js';
import { parseConfig } from '../managedAgents/config.js';
import { enqueueGithub, flushGithubIntake } from '../durableIntake.js';
import type { SmolpawsQueueMessage } from '../../../../src/shared/github.js';
import { testDatabase } from './helpers/managedD1.js';

const token = 'fixture-worker-service-credential-32-plus';
function config() {
  const c = parseConfig(readFileSync(new URL('../../managed-agents.example.json', import.meta.url), 'utf8'));
  c.enabled = true; c.poll.enabled = true; c.poll.activation_timestamp = '2026-10-22T00:00:00Z';
  c.direct_intake.enabled = true;
  return c;
}
const repo = { id: 1043426082, full_name: 'OpenHands/software-agent-sdk', default_branch: 'main', private: false };
function githubRead(url: string): Response {
  if (url.endsWith('/repositories/1043426082')) return Response.json(repo);
  if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
  if (url.includes('/comments?')) return Response.json([]);
  if (/\/issues\/\d+$/.test(url)) return Response.json({ title: 'Fixture', body: 'Public', user: { login: 'enyst' } });
  throw new Error(`Unexpected fixture request ${url}`);
}

test('direct intake authenticates before reads, rejects forged principals, and exposes redacted status', async t => {
  const storage = testDatabase(); t.after(storage.close);
  const env: ManagedEnv = { MANAGED_AGENTS_CONFIG: JSON.stringify(config()), GITHUB_DB: storage.db,
    MANAGED_AGENTS_SERVICE_TOKEN: token, MANAGED_OPENAI_API_KEY: 'synthetic-provider-secret' };
  let reads = 0;
  const send = (async url => { reads++; return githubRead(String(url)); }) as typeof fetch;
  const input = { provider: 'codex', clientRequestId: 'client_1', repositoryId: repo.id, issueNumber: 1, body: 'Review this public issue' };
  const request = (body = input, authorization = `Bearer ${token}`) => new Request('https://worker.example/managed-agents/requests',
    { method: 'POST', headers: { Authorization: authorization }, body: JSON.stringify(body) });
  assert.equal((await managedHttp(request(input, 'Bearer attacker'), env, send))?.status, 401); assert.equal(reads, 0);
  assert.equal((await managedHttp(request({ ...input, principalId: 6080905 } as typeof input), env, send))?.status, 400); assert.equal(reads, 0);
  assert.equal((await managedHttp(request({ ...input, clientRequestId: undefined } as unknown as typeof input), env, send))?.status, 400); assert.equal(reads, 1);
  const result = (await managedHttp(request(), env, send))!; assert.equal(result.status, 202);
  const data = await result.json() as { runs: { runId: string }[] };
  const status = await managedHttp(new Request(`https://worker.example/managed-agents/runs/${data.runs[0].runId}`,
    { headers: { Authorization: `Bearer ${token}` } }), env, send);
  assert.equal(status?.status, 200);
  const text = await status!.text(); assert(!text.includes(input.body)); assert(!text.includes('secret')); assert(!text.includes(token));
  assert.equal(reads, 5); // The invalid request fetched only metadata; the valid one fetched bounded context too.
});

test('the small tool client retains caller request IDs and cannot select another repository', async () => {
  let payload: Record<string, unknown> = {};
  const client = managedAgentTools('https://worker.example', token, (async (_url, init) => {
    payload = JSON.parse(String(init?.body)); return Response.json({ runs: [] });
  }) as typeof fetch);
  await client.ask_claude({ clientRequestId: 'stable_id', issueNumber: 3, body: 'Explain' });
  assert.equal(payload.clientRequestId, 'stable_id'); assert.equal(payload.repositoryId, repo.id); assert.equal(payload.provider, 'claude');
  assert(!JSON.stringify(payload).includes(token));
});

test('hostile GitHub pagination cannot receive the credential; marker reconciliation checks immutable writer IDs', async () => {
  const c = config(), calls: string[] = [];
  let hostile = true;
  const github = createGithubGateway(c, 'synthetic-github-secret', (async url => {
    calls.push(String(url));
    if (String(url).endsWith('/repositories/1043426082')) return Response.json(repo);
    return Response.json([{ id: 1, body: 'marker', user: { id: 999, login: 'smolpaws' } },
      { id: 2, body: 'marker', user: { id: 255025612, login: 'renamable' } }],
    { headers: hostile ? { Link: '<https://attacker.example/steal>; rel="next"' } : {} });
  }) as typeof fetch);
  await assert.rejects(github.page('issue_comment', Date.now()), /untrusted_pagination/);
  assert(calls.every(url => new URL(url).hostname === 'api.github.com'));
  hostile = false; assert.deepEqual(await github.findReply(1, 'marker'), [2]);
});

test('legacy D1 handoff recovers queue failure and rejects the historical lookback at cutover', async t => {
  const storage = testDatabase(); t.after(storage.close);
  let fail = true, sends = 0, created = '2026-10-22T12:00:00Z';
  const sent: SmolpawsQueueMessage[] = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ created_at: created }));
  const env = { GITHUB_DB: storage.db, GITHUB_DURABLE_INTAKE_BASELINE: '2026-10-22T00:00:00Z',
    SMOLPAWS_QUEUE: { async send(message: SmolpawsQueueMessage) { sends++; if (fail) throw new Error('queue unavailable'); sent.push(message); } } as unknown as Queue<SmolpawsQueueMessage> };
  const message: SmolpawsQueueMessage = { event: 'issue_comment', payload: { repository: { full_name: repo.full_name }, comment: { id: 1, body: '@smolpaws help' } } };
  await assert.rejects(enqueueGithub(env, message, 'comment_1'), /handoff pending/);
  fail = false; await flushGithubIntake(env); await enqueueGithub(env, message, 'comment_1');
  assert.equal(sends, 2); assert.equal(sent.length, 1); assert.equal(sent[0].delivery_id, 'comment_1');
  created = '2026-10-21T23:59:59Z'; await enqueueGithub(env, message, 'old_comment');
  assert.equal(sent.length, 1);
});

test('durable cutover preserves ordinary review-summary requests using their verified submitted timestamp', async t => {
  const storage = testDatabase(); t.after(storage.close);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('A review ID is not an inline-comment ID'); });
  const sent: SmolpawsQueueMessage[] = [];
  const env = { GITHUB_DB: storage.db, GITHUB_DURABLE_INTAKE_BASELINE: '2026-10-22T00:00:00Z',
    SMOLPAWS_QUEUE: { async send(message: SmolpawsQueueMessage) { sent.push(message); } } as unknown as Queue<SmolpawsQueueMessage> };
  const message: SmolpawsQueueMessage = { event: 'pull_request_review_comment', payload: { repository: { full_name: repo.full_name },
    pull_request: { number: 1 }, comment: { id: 888, body: '@smolpaws follow up on my review' } } };
  await enqueueGithub(env, message, 'review_888', '2026-10-22T12:00:00Z');
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.comment?.body, message.payload.comment?.body);
});

test('a signed managed webhook is consumed before local self filtering and never calls the unavailable runner', async t => {
  const storage = testDatabase(); t.after(storage.close);
  const source = { id: 900, body: '@codex explain this', created_at: '2026-10-22T12:00:00Z', user: { id: 255025612, login: 'smolpaws' },
    issue_url: `https://api.github.com/repos/${repo.full_name}/issues/1`, html_url: '' };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return String(url).includes('/issues/comments/900') ? Response.json(source) : githubRead(String(url));
  });
  let queued = 0;
  const env = { MANAGED_AGENTS_CONFIG: JSON.stringify(config()), GITHUB_DB: storage.db, ALLOWED_ACTORS: 'enyst',
    GITHUB_WEBHOOK_SECRET: 'fixture-webhook-secret', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '',
    SMOLPAWS_RUNNER_URL: 'https://unavailable-runner.example', SMOLPAWS_QUEUE: { async send() { queued++; } } as unknown as Queue<SmolpawsQueueMessage> };
  const body = JSON.stringify({ action: 'created', sender: source.user, repository: repo, comment: source, issue: { number: 1 } });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const response = await worker.fetch(new Request('https://worker.example/webhooks/github', { method: 'POST', body,
    headers: { 'X-GitHub-Event': 'issue_comment', 'X-Hub-Signature-256': `sha256=${signature}` } }), env);
  assert.equal(response.status, 202); assert.equal(queued, 0);
  assert(!calls.some(url => url.includes('runner')));
});

test('Worker intake, cron, hosted adapter and publication finish with the local runner unreachable', async t => {
  const storage = testDatabase(); t.after(storage.close);
  const c = config(); c.mode = 'active'; c.publication.comments_enabled = true;
  c.routes.codex = { enabled: true, model: 'fixture-codex', network_allowed_domains: ['github.com'] };
  let time = Date.parse('2026-10-22T12:00:00Z'), creates = 0;
  t.mock.method(Date, 'now', () => time);
  const posts: string[] = [], calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.includes('unreachable-runner')) throw new Error('local runner unavailable');
    if (url.endsWith('/notifications') || url.includes('/notifications?')) return Response.json([]);
    if (url.endsWith('/user')) return Response.json({ id: 255025612 });
    if (url === 'https://api.openai.com/v1/agents/sessions' && init?.method === 'POST') { creates++; return Response.json({ id: 'sess_fixture' }); }
    if (url.includes('api.openai.com')) {
      if (url.includes('/items?')) return Response.json({ data: [{ type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'Inspected the fixture; no proven finding.' }] }], has_more: false });
      if (url.includes('/turns?')) return Response.json({ data: [{ id: 'turn_root', subagent_id: null, status: 'completed' }], has_more: false });
      return Response.json({ required_actions: [] });
    }
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body)).body); return Response.json({ id: 999, user: { id: 255025612 } }); }
    return githubRead(url);
  });
  const env = { MANAGED_AGENTS_CONFIG: JSON.stringify(c), GITHUB_DB: storage.db, ALLOWED_ACTORS: 'enyst',
    MANAGED_AGENTS_SERVICE_TOKEN: token, MANAGED_OPENAI_API_KEY: 'synthetic-openai-secret', GITHUB_USER_TOKEN: 'synthetic-github-secret',
    GITHUB_WEBHOOK_SECRET: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', SMOLPAWS_RUNNER_URL: 'https://unreachable-runner.example',
    SMOLPAWS_QUEUE: { async send() { throw new Error('managed work must not use the local queue'); } } as unknown as Queue<SmolpawsQueueMessage> };
  const response = await worker.fetch(new Request('https://worker.example/managed-agents/requests', { method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ provider: 'codex', clientRequestId: 'whole_lifecycle',
      repositoryId: repo.id, issueNumber: 1, body: 'Review the fixture' }) }), env);
  assert.equal(response.status, 202);
  const admitted = await response.json() as { runs: { runId: string }[] };
  for (let i = 0; i < 3; i++) {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as ScheduledController, env, { waitUntil(promise) { pending.push(promise); } } as ExecutionContext);
    await Promise.all(pending); time += 61_000;
  }
  const status = await storage.db.prepare('SELECT state FROM managed_runs WHERE run_id=?').bind(admitted.runs[0].runId).first<{ state: string }>();
  assert.equal(status?.state, 'delivered'); assert.equal(creates, 1); assert.equal(posts.length, 1);
  assert(posts[0].includes('assessed commit')); assert(posts[0].includes('a'.repeat(40)));
  assert(!posts[0].includes('secret')); assert(!calls.some(url => url.includes('unreachable-runner')));
});
