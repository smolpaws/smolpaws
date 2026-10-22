import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { createManagedRouter } from '../managedAgents/index.js';
import { parseConfig } from '../managedAgents/config.js';
import { MutationError } from '../managedAgents/http.js';
import { Ledger } from '../managedAgents/ledger.js';
import type { Comment, GithubGateway, ProviderAdapter } from '../managedAgents/types.js';
import { testDatabase } from './helpers/managedD1.js';

function fixture(t: TestContext, active = true) {
  const storage = testDatabase(); t.after(storage.close);
  const config = parseConfig(readFileSync(new URL('../../managed-agents.example.json', import.meta.url), 'utf8'));
  config.enabled = true; config.mode = active ? 'active' : 'shadow';
  config.poll.enabled = true;
  config.poll.activation_timestamp = '2026-10-22T00:00:00Z';
  config.direct_intake.enabled = true; config.publication.comments_enabled = active;
  config.routes.codex = { enabled: true, model: 'fixture-codex' };
  config.routes.claude = { enabled: true, model: 'fixture-claude', agent_id: 'agent_fixture', agent_version: 1, environment_id: 'env_fixture' };
  let time = Date.parse('2026-10-22T12:00:00Z');
  const comments = new Map<number, Comment>();
  const posts: { id: number; body: string }[] = [];
  let starts = 0, observations = 0, lostPost = false, lostStart = false, sha = 'a'.repeat(40);
  const github: GithubGateway = {
    async repository() { return { id: 1043426082, full_name: 'OpenHands/software-agent-sdk', private: false, default_branch: 'main' }; },
    async source(_surface, id) {
      const posted = posts.find(p => p.id === id);
      return comments.get(id) ?? (posted ? { ...posted, user: { id: 255025612, login: 'smolpaws' }, created_at: '2026-10-22T12:00:00Z', html_url: '', issue_url: 'https://api.github.com/repos/OpenHands/software-agent-sdk/issues/1' } : null);
    },
    async page(surface) { return { comments: surface === 'issue_comment' ? [...comments.values()] : [], next: null }; },
    async target(issueNumber) { return { issueNumber, sha, title: 'A public fixture', isPr: true, context: 'Other-author context' }; },
    async writerId() { return 255025612; },
    async findReply(_issue, marker) { return posts.filter(p => p.body.includes(marker)).map(p => p.id); },
    async postReply(_issue, body) {
      const id = posts.length + 1; posts.push({ id, body });
      if (lostPost) throw new MutationError(true);
      return id;
    },
    async editReply(id, body) { posts.find(p => p.id === id)!.body = body; return id; },
  };
  const provider: ProviderAdapter = {
    async start() { starts++; if (lostStart) throw new MutationError(true); return `session_${starts}`; },
    async observe() { observations++; return { state: 'completed', text: 'Checked the pinned commit.\n\nNo proven finding. @codex' }; },
    async cancel() {},
  };
  const router = createManagedRouter({ db: storage.db, config, github, providers: { codex: provider, claude: provider }, now: () => time });
  function source(id: number, body = '@codex review this PR', author = 6080905) {
    comments.set(id, { id, body, user: { id: author, login: 'display-name-is-not-authority' }, created_at: '2026-10-22T11:59:00Z',
      html_url: `https://github.com/OpenHands/software-agent-sdk/pull/1#issuecomment-${id}`,
      issue_url: 'https://api.github.com/repos/OpenHands/software-agent-sdk/issues/1' });
    return { kind: 'github' as const, surface: 'issue_comment' as const, sourceId: id };
  }
  return { router, config, comments, posts, source, github, provider, db: storage.db,
    advance(minutes = 1) { time += minutes * 60_000; }, now: () => time, starts: () => starts, observations: () => observations,
    losePost() { lostPost = true; }, loseStart() { lostStart = true; }, moveHead() { sha = 'b'.repeat(40); } };
}

test('shadow intake durably deduplicates both providers without dispatch or publication', async t => {
  const f = fixture(t, false), input = f.source(101, '@codex review; @claude explain');
  const first = await f.router.accept(input), second = await f.router.accept(input);
  assert.equal(first.length, 2); assert.deepEqual(second.map(r => r.runId), first.map(r => r.runId));
  await f.router.tick();
  assert(first.every(r => r.state === 'shadow')); assert.equal(f.starts(), 0); assert.equal(f.posts.length, 0);
});

test('removal before dispatch cancels; historical and generated comments never start a job', async t => {
  const f = fixture(t), input = f.source(120);
  const [run] = await f.router.accept(input); f.comments.get(120)!.body = 'removed';
  await f.router.tick(); assert.equal(f.starts(), 0);
  assert.equal((await f.router.status(run.runId))?.state, 'canceled');
  const historical = f.source(121); f.comments.get(121)!.created_at = '2026-10-21T23:59:59Z';
  assert.deepEqual(await f.router.accept(historical), []);
  const generated = f.source(122, '@codex quoted output', 255025612);
  await f.db.prepare('INSERT INTO github_generated_comments VALUES(?,?)').bind(1043426082, 122).run();
  assert.deepEqual(await f.router.accept(generated), []);
  assert.equal((await f.router.accept(f.source(123, '@claude review', 255025612))).length, 1);
});

test('concurrent admission reserves a daily budget once and serializes a thread/provider', async t => {
  const f = fixture(t);
  f.config.limits.max_requests_per_day = 2;
  const requests = [130, 131, 132].map(id => f.source(id));
  const results = (await Promise.all(requests.map(r => f.router.accept(r)))).flat();
  assert.equal(results.filter(r => r.state === 'accepted').length, 2);
  assert.equal(results.filter(r => r.state === 'budget_paused').length, 1);
  const bucket = await f.db.prepare('SELECT requests,reserved_cents FROM managed_budgets').first();
  assert.deepEqual({ ...bucket }, { requests: 2, reserved_cents: 1000 });
  f.provider.observe = async () => ({ state: 'running' });
  await f.router.tick(); f.advance(); await f.router.tick();
  assert.equal(f.starts(), 1);
});

test('partial scans resume their continuation and admit several comments between ticks', async t => {
  const f = fixture(t, false); f.config.poll.max_pages_per_tick = 1;
  const a = f.source(140), b = f.source(141), c = f.source(142);
  const seen: (string | null | undefined)[] = [];
  f.github.page = async (surface, _since, next) => {
    if (surface !== 'issue_comment') return { comments: [], next: null };
    seen.push(next);
    return next ? { comments: [f.comments.get(c.sourceId)!], next: null }
      : { comments: [f.comments.get(a.sourceId)!, f.comments.get(b.sourceId)!], next: 'fixture-page-2' };
  };
  await f.router.tick(); f.advance(); await f.router.tick();
  assert.deepEqual(seen, [null, 'fixture-page-2']);
  const rows = await f.db.prepare('SELECT run_id FROM managed_runs').all();
  assert.equal(rows.results.length, 3);
  const cursor = await f.db.prepare("SELECT next_url,scan_ms,cursor_ms FROM managed_scans WHERE surface='issue_comment'").first<{ next_url: null; scan_ms: null; cursor_ms: number }>();
  assert.equal(cursor?.next_url, null); assert.equal(cursor?.scan_ms, null);
  assert.equal(cursor?.cursor_ms, f.now() - 60_000);
});

test('pausing intake preserves monitoring; permission waits and budget pauses remain pending', async t => {
  const f = fixture(t), [run] = await f.router.accept(f.source(150));
  await f.router.tick(); f.config.poll.enabled = false;
  f.provider.observe = async () => ({ state: 'awaiting_action', reason: 'provider_requires_action' });
  f.advance(); await f.router.tick();
  assert.equal((await f.router.status(run.runId))?.state, 'awaiting_action');
  assert.equal(f.posts.length, 1); assert(!f.posts[0].body.includes('assessed commit'));
  f.provider.observe = async () => ({ state: 'budget_paused', reason: 'provider_budget_reached' });
  f.advance(); await f.router.tick();
  assert.equal((await f.router.status(run.runId))?.state, 'budget_paused');
  assert.equal(f.posts.length, 1); assert(f.posts[0].body.includes('budget_paused'));
});

test('watchdog attempts cancellation once even while a status reply is unresolved', async t => {
  const f = fixture(t), [run] = await f.router.accept(f.source(160));
  let canceled = 0;
  f.provider.observe = async () => ({ state: 'awaiting_action', reason: 'provider_requires_action' });
  f.provider.cancel = async () => { canceled++; throw new MutationError(true); };
  f.github.findReply = async () => []; f.losePost();
  await f.router.tick(); f.advance(); await f.router.tick();
  f.advance(20); await f.router.tick(); f.advance(); await f.router.tick();
  assert.equal(canceled, 1); assert.equal(f.starts(), 1); assert.equal(f.posts.length, 1);
  assert.equal((await f.router.status(run.runId))?.state, 'delivery_unknown');
});

test('stale owners cannot overwrite progress; a late creation receipt recovers without another create', async t => {
  const f = fixture(t), [status] = await f.router.accept(f.source(170));
  const ledger = new Ledger(f.db, f.now), run = (await ledger.get(status.runId))!;
  const claimed = (await ledger.claim(run, 'old-owner', 2))!;
  f.advance(2); await ledger.recover();
  assert.equal(await ledger.update(claimed, { state: 'accepted' }), null);
  await ledger.receipt(run.run_id, 'session_late'); await ledger.recover();
  assert.equal((await ledger.get(run.run_id))?.session_id, 'session_late');
  f.provider.observe = async () => ({ state: 'running' });
  await f.router.tick(); assert.equal(f.starts(), 0);
});

test('author IDs authorize intake; editing an accepted request cannot change its prompt', async t => {
  const f = fixture(t), input = f.source(102);
  const [run] = await f.router.accept(input);
  f.comments.get(102)!.body = '@codex an edited request';
  assert.equal((await f.router.accept(input))[0].runId, run.runId);
  await assert.rejects(f.router.accept(f.source(103, '@codex act', 999)), /author_not_allowed/);
  let dispatched = '';
  f.provider.start = async text => { dispatched = text; return 'session_frozen'; };
  await f.router.tick();
  assert(dispatched.includes('@codex review this PR')); assert(!dispatched.includes('an edited request'));
});

test('direct requests have stable identities and reject changed destinations or bodies', async t => {
  const f = fixture(t);
  const request = { kind: 'direct' as const, provider: 'codex' as const, clientRequestId: 'req_1', issueNumber: 1, body: 'Review the fixture' };
  const [first] = await f.router.accept(request);
  assert.equal((await f.router.accept(request))[0].runId, first.runId);
  await assert.rejects(f.router.accept({ ...request, issueNumber: 2 }), /idempotency_conflict/);
});

test('a lost creation acknowledgement becomes action-required and never creates a second session', async t => {
  const f = fixture(t); f.loseStart(); const [run] = await f.router.accept(f.source(104));
  await f.router.tick(); f.advance(); await f.router.tick();
  assert.equal(f.starts(), 1);
  const status = await f.router.status(run.runId);
  assert.equal(status?.state, 'dispatch_unknown'); assert.equal(status?.actionRequired, true);
});

test('a lost GitHub acknowledgement is reconciled by writer and marker without another post', async t => {
  const f = fixture(t); f.losePost(); const [run] = await f.router.accept(f.source(105));
  for (let i = 0; i < 5; i++) { await f.router.tick(); f.advance(); }
  assert.equal(f.starts(), 1); assert.equal(f.posts.length, 1);
  assert.equal((await f.router.status(run.runId))?.state, 'delivered');
  assert(f.posts[0].body.includes('a'.repeat(40))); assert(!f.posts[0].body.includes('@codex'));
});

test('a moving PR head remains visibly attributed to the commit actually assessed', async t => {
  const f = fixture(t); await f.router.accept(f.source(106));
  await f.router.tick(); f.advance(); await f.router.tick(); f.moveHead();
  f.advance(); await f.router.tick();
  assert.equal(f.posts.length, 1); assert(f.posts[0].body.includes('a'.repeat(40)));
  assert(f.posts[0].body.includes('changed'));
});
