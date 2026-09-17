/**
 * Coordinator-layer tests (ADR §4 interface) against a faithful in-memory agent-server fake.
 *
 * The fake's searchEvents mirrors the real agent-server's numeric-offset pagination
 * (packages/openhands-agent-server eventService.searchEvents), and appendEvent is idempotent on a
 * caller-supplied event id (the ADR §8 delta) so the append-response-loss window can be proven.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { MessageRelay, bridgeResponseExtractor, sendMessageExtractor, terminalResponseExtractor } from './messageRelay.js';
import { deterministicEventId } from './ids.js';
import { MessageWorkStore } from './store.js';
import { TaskScheduler, type ScheduledLane, type ScheduledTask } from './taskScheduler.js';
import type { AgentEvent, AgentServerClient, LaneDescriptor, RetryPolicy } from './types.js';

const POLICY: RetryPolicy = { maxAttempts: 3, baseBackoffMs: 1_000, capBackoffMs: 8_000, claimTtlMs: 1_000 };

function tempDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'mwc-coord-')), 'c.db');
}

function lane(overrides: Partial<LaneDescriptor> = {}): LaneDescriptor {
  return { laneKey: 'channel:slack:T1:C1:root', platform: 'slack', accountId: 'T1', chatId: 'C1', threadId: null, ...overrides };
}

/** In-memory agent-server fake. */
class FakeAgentServer implements AgentServerClient {
  ensureCalls: string[] = [];
  appended = new Map<string, { eventId: string; content: unknown }>();
  events: AgentEvent[] = [];
  /** Optional: fail the next N appendEvent calls with a (retryable) error. */
  failNextAppends = 0;
  failNonRetryable = false;

  async ensureConversation(conversationId: string): Promise<void> {
    this.ensureCalls.push(conversationId);
  }

  async appendEvent(
    conversationId: string,
    event: { eventId: string; role: string; content: unknown; run: boolean },
  ): Promise<{ eventId: string; created: boolean }> {
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1;
      const err = new Error('append transport failure') as Error & { nonRetryable?: boolean };
      if (this.failNonRetryable) err.nonRetryable = true;
      throw err;
    }
    const key = `${conversationId}:${event.eventId}`;
    if (this.appended.has(key)) {
      return { eventId: event.eventId, created: false }; // idempotent replay
    }
    this.appended.set(key, { eventId: event.eventId, content: event.content });
    return { eventId: event.eventId, created: true };
  }

  /** When true, searchEvents throws a 404 as if the conversation is gone from the agent-server. */
  conversationAbsent = false;
  searchCalls = 0;

  async searchEvents(
    _conversationId: string,
    pageId: string | null,
    limit: number,
  ): Promise<{ items: AgentEvent[]; nextPageId: string | null }> {
    this.searchCalls += 1;
    if (this.conversationAbsent) {
      const err = new Error('searchEvents failed: 404') as Error & { status?: number; nonRetryable?: boolean };
      err.status = 404;
      err.nonRetryable = true;
      throw err;
    }
    const start = pageId === null ? 0 : Math.max(0, Number.parseInt(pageId, 10) || 0);
    const items = this.events.slice(start, start + limit);
    const nextPageId = start + limit < this.events.length ? String(start + limit) : null;
    return { items, nextPageId };
  }
}

function makeCoordinator(now: () => number, agent = new FakeAgentServer(), extractor?: typeof terminalResponseExtractor) {
  const store = new MessageWorkStore(new Database(tempDbPath()), POLICY);
  const coord = new MessageRelay(store, agent, { now, outboxSyncPageSize: 2, ...(extractor ? { extractor } : {}) });
  return { store, coord, agent };
}

function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// ---- resolveLane / ensure conversation -------------------------------------------------------------

test('resolveLane ensures the conversation exactly once', async () => {
  const c = clock();
  const { coord, agent } = makeCoordinator(c.now);
  const b1 = await coord.resolveLane(lane());
  assert.equal(b1.conversationReady, true);
  await coord.resolveLane(lane());
  assert.equal(agent.ensureCalls.length, 1); // second resolve sees conversation_ready
});

// ---- accept + integrate ----------------------------------------------------------------------------

test('acceptInbound is idempotent and defers the append to integration', async () => {
  const c = clock();
  const { coord, agent } = makeCoordinator(c.now);
  const r1 = await coord.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hi' });
  const r2 = await coord.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hi' });
  assert.equal(r1.id, r2.id); // dedup on platform message id
  assert.equal(agent.appended.size, 0); // nothing appended yet
  assert.equal(r1.agentEventId, deterministicEventId('slack', 'm1'));
});

test('integrateNextIntake appends the deterministic user event with run and settles done', async () => {
  const c = clock();
  const { coord, agent } = makeCoordinator(c.now);
  await coord.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hello' });
  const outcome = await coord.integrateNextIntake('w1');
  assert.equal(outcome.kind, 'integrated');
  assert.equal(agent.appended.size, 1);
  const appended = [...agent.appended.values()][0];
  assert.equal(appended.eventId, deterministicEventId('slack', 'm1'));
  // Nothing left to do.
  assert.deepEqual(await coord.integrateNextIntake('w1'), { kind: 'idle' });
});

test('append-response-loss: a retried integration reuses the same event id and is deduped', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now);
  const work = await coord.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hello' });

  // First integration attempt: the append "succeeds" server-side but the response is lost (thrown).
  agent.failNextAppends = 1;
  const first = await coord.integrateNextIntake('w1');
  assert.equal(first.kind, 'retry');

  // Simulate the lost-write reality: mark that the server actually persisted it.
  const boundLane = store.getLane(work.laneKey);
  assert.ok(boundLane);
  agent.appended.set(`${boundLane.conversationId}:${work.agentEventId}`, {
    eventId: work.agentEventId!,
    content: 'hello',
  });

  // Backoff elapses, reconcile promotes retry_wait → ready, retry re-appends the SAME id → created:false.
  c.advance(2_000);
  store.reconcile(c.now());
  const second = await coord.integrateNextIntake('w1');
  assert.equal(second.kind, 'integrated');
  assert.equal((second as { eventCreated: boolean }).eventCreated, false); // idempotent, not duplicated
  assert.equal(agent.appended.size, 1);
});

test('a non-retryable append error fails the intake', async () => {
  const c = clock();
  const { coord, agent } = makeCoordinator(c.now);
  await coord.acceptInbound(lane(), { sourceMessageId: 'm1', content: 'hello' });
  agent.failNextAppends = 1;
  agent.failNonRetryable = true;
  const outcome = await coord.integrateNextIntake('w1');
  assert.equal(outcome.kind, 'failed');
});

// ---- projection ------------------------------------------------------------------------------------

const sendAction = (id: string, text: string): AgentEvent => ({
  id,
  kind: 'ActionEvent',
  tool_name: 'send_message',
  action: { text },
});

const assistantMessage = (id: string, text: string, extra: Record<string, unknown> = {}): AgentEvent => ({
  id,
  kind: 'MessageEvent',
  source: 'agent',
  llm_message: { role: 'assistant', content: [{ type: 'text', text }], ...extra },
});

const finishObservation = (id: string, text: string): AgentEvent => ({
  id,
  kind: 'ObservationEvent',
  tool_name: 'finish',
  observation: { message: text },
});

const conversationError = (id: string, code: string, detail: string): AgentEvent => ({
  id,
  kind: 'ConversationErrorEvent',
  source: 'environment',
  code,
  detail,
});

for (const observation of [{ message: '' }, { message: ' \n\t ' }, { text: '' }, { text: ' \n\t ' }]) {
  test(`blank scheduled finish ${JSON.stringify(observation)} completes quietly and preserves later delivery`, async () => {
    const c = clock();
    const database = new Database(':memory:');
    const store = new MessageWorkStore(database, POLICY);
    const scheduler = new TaskScheduler(':memory:', c.now);
    const agent = new FakeAgentServer();
    const observed: AgentEvent[] = [];
    const relay = new MessageRelay(store, agent, {
      now: c.now, outboxSyncPageSize: 1, extractor: bridgeResponseExtractor,
      onEvent: (conversationId, event) => { observed.push(event); scheduler.observe(conversationId, event); },
    });
    try {
      const origin = lane({ laneKey: 'whatsapp:poll', platform: 'whatsapp', chatId: 'poll' });
      const binding = await relay.resolveLane(origin);
      scheduler.register({ conversationId: binding.conversationId, lane: origin, scopeId: 'poll',
        workingDir: '/tmp', relayDbPath: ':memory:', defaults: {} });
      scheduler.execute(binding.conversationId, 'schedule_task', {
        prompt: 'Poll for new mentions; finish with an empty message when there are none.',
        schedule_type: 'interval', schedule_value: '1000', context_mode: 'isolated',
      }, 'schedule');
      c.advance(1000);
      const [run] = scheduler.due('whatsapp');
      const registration = JSON.parse(run.lane_json) as ScheduledLane;
      store.resolveLane(registration.lane, run.conversation_id, c.now());
      scheduler.enqueued(run.id);
      const output: AgentEvent = { id: 'poll-output', kind: 'ObservationEvent', tool_name: 'terminal',
        observation: { text: 'poll: no new mentions', is_error: false } };
      agent.events = [
        { id: deterministicEventId('whatsapp', run.source_id), kind: 'MessageEvent', source: 'user' },
        output,
        { id: 'quiet-finish', kind: 'ObservationEvent', tool_name: 'finish', observation },
      ];

      assert.equal(await relay.syncDeliveryOutbox(run.conversation_id), 0);
      assert.deepEqual(store.listLaneWork(registration.lane.laneKey, 'delivery'), []);
      assert.deepEqual(observed, agent.events); // Tool output and completion still reach event observers.
      assert.equal(store.getProjectionCursor(run.conversation_id), '3');
      assert.deepEqual(scheduler.db.prepare('SELECT status FROM scheduler_runs WHERE id=?').get(run.id), { status: 'done' });
      const [task] = JSON.parse(scheduler.execute(binding.conversationId, 'list_tasks', {}, 'list').text) as ScheduledTask[];
      assert.equal(task.last_result, observation.message ?? observation.text);
      assert.equal(task.last_run, new Date(c.now()).toISOString());
      assert.equal(task.next_run, new Date(c.now() + 1000).toISOString());

      agent.events.push(sendAction('explicit', 'Checking a new mention'), finishObservation('useful', '  Found a new mention.\n'),
        conversationError('failure', 'ProviderError', 'private error details'));
      assert.equal(await relay.syncDeliveryOutbox(run.conversation_id), 3);
      const deliveries = store.listLaneWork(registration.lane.laneKey, 'delivery');
      assert.deepEqual(deliveries.map(row => row.agentEventId), ['explicit', 'useful', 'failure']);
      assert.equal((deliveries[1].payload as { text: string }).text, '  Found a new mention.\n');
      assert.equal(await relay.syncDeliveryOutbox(run.conversation_id), 0);
      c.advance(1000);
      assert.equal(scheduler.due('whatsapp').length, 1);
    } finally {
      scheduler.close();
      database.close();
    }
  });
}

test('conversation failures project safe notices while recoverable tool and server events do not', async () => {
  const { store, coord, agent } = makeCoordinator(Date.now, new FakeAgentServer(), bridgeResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [
    { id: 'tool-error', kind: 'AgentErrorEvent', error: 'Tool failed; the agent can recover.' },
    { id: 'observation-error', kind: 'ObservationEvent', tool_name: 'terminal', observation: { is_error: true, text: 'Command failed.' } },
    { id: 'server-error', kind: 'ServerErrorEvent', detail: 'Socket closed.' },
    conversationError('steps', 'MaxIterationsReached', 'Agent reached maximum iterations limit (12).'),
    conversationError('provider', 'ProviderAuthError', 'private provider URL, access token, and response body'),
  ];

  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 2);
  const deliveries = store.listLaneWork(binding.laneKey, 'delivery');
  assert.deepEqual(deliveries.map(row => ({ id: row.agentEventId, payload: row.payload })), [
    { id: 'steps', payload: { kind: 'current_thread_message', text: 'I stopped because this run reached its 12-step limit. Send another message to continue.' } },
    { id: 'provider', payload: { kind: 'current_thread_message', text: 'I encountered a conversation error. Send another message to try continuing.' } },
  ]);
  assert.equal(store.getProjectionCursor(binding.conversationId), '5');
});

test('failure notices survive a database restart and cursor replay without hiding a later failure', async () => {
  const dbPath = tempDbPath();
  const agent = new FakeAgentServer();
  let database = new Database(dbPath);
  let store = new MessageWorkStore(database, POLICY);
  const make = () => new MessageRelay(store, agent, { extractor: bridgeResponseExtractor, outboxSyncPageSize: 1 });
  let relay = make();
  const binding = await relay.resolveLane(lane());
  agent.events = [conversationError('first-failure', 'MaxIterationsReached', 'Agent reached maximum iterations limit (12).')];
  try {
    assert.equal(await relay.syncDeliveryOutbox(binding.conversationId), 1);
    assert.equal(store.listLaneWork(binding.laneKey, 'delivery')[0]?.sourceKey, `first-failure:${binding.laneKey}`);
    database.close();
    database = new Database(dbPath);
    store = new MessageWorkStore(database, POLICY);
    relay = make();
    assert.equal(await relay.syncDeliveryOutbox(binding.conversationId), 0);

    // Simulate a crash after the durable delivery insert but before cursor advancement.
    store.setProjectionCursor(binding.conversationId, '0', Date.now());
    assert.equal(await relay.syncDeliveryOutbox(binding.conversationId), 0);
    agent.events.push(conversationError('next-failure', 'MaxIterationsReached', 'Agent reached maximum iterations limit (12).'));
    assert.equal(await relay.syncDeliveryOutbox(binding.conversationId), 1);
    assert.equal(store.listLaneWork(binding.laneKey, 'delivery').length, 2);
    assert.equal(await make().syncDeliveryOutbox(binding.conversationId), 0);
  } finally {
    database.close();
  }
});

test('a conversation error is delivered even when an explicit send used the same notice text', async () => {
  const { store, coord, agent } = makeCoordinator(Date.now, new FakeAgentServer(), bridgeResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [
    sendAction('send', 'I stopped because this run reached its 12-step limit. Send another message to continue.'),
    conversationError('failure', 'MaxIterationsReached', 'Agent reached maximum iterations limit (12).'),
  ];
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 2);
  assert.equal(store.listLaneWork(binding.laneKey, 'delivery').length, 2);
});

test('max-step notices only include a positive safe integer from the exact SDK detail format', () => {
  for (const detail of [
    'private detail',
    'Agent reached maximum iterations limit (12). secret',
    'Agent reached maximum iterations limit (12).\nsecret',
    'Agent reached maximum iterations limit (-1).',
    'Agent reached maximum iterations limit (0).',
    'Agent reached maximum iterations limit (1.5).',
    'Agent reached maximum iterations limit (9007199254740992).',
  ]) {
    assert.deepEqual(bridgeResponseExtractor(conversationError('failure', 'MaxIterationsReached', detail)), {
      payload: { kind: 'current_thread_message', text: 'I stopped because this run reached its step limit. Send another message to continue.' },
    });
  }
});

test('final echoes are suppressed across pages and projector restart, but new turns and explicit sends survive', async () => {
  const agent = new FakeAgentServer();
  const { store } = makeCoordinator(Date.now, agent);
  const make = () => new MessageRelay(store, agent, { outboxSyncPageSize: 1,
    extractor: event => sendMessageExtractor(event) ?? terminalResponseExtractor(event) });
  const coord = make(); const binding = await coord.resolveLane(lane());
  const user = (id: string): AgentEvent => ({ id, kind: 'MessageEvent', source: 'user', llm_message: { role: 'user', content: [] } });
  agent.events = [user('u1'), sendAction('s1', 'hello')];
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 1);
  agent.events.push(finishObservation('f1', 'hello'));
  const restarted = make();
  assert.equal(await restarted.syncDeliveryOutbox(binding.conversationId), 0);
  agent.events.push(user('u2'), finishObservation('f2', 'hello'));
  assert.equal(await restarted.syncDeliveryOutbox(binding.conversationId), 1);
  agent.events.push(user('u3'), sendAction('s2', 'hello'), sendAction('s3', 'hello'), assistantMessage('a3', 'different final'));
  assert.equal(await restarted.syncDeliveryOutbox(binding.conversationId), 3);
  assert.equal(store.listLaneWork(binding.laneKey, 'delivery').length, 5);
  assert.equal(await make().syncDeliveryOutbox(binding.conversationId), 0);
});

test('a send_message event without a delivery cannot suppress the final reply', async () => {
  const { coord, agent } = makeCoordinator(Date.now, new FakeAgentServer(), terminalResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [sendAction('s1', 'hello'), finishObservation('f1', 'hello')];
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 1);
});

test('terminalResponseExtractor delivers a plain assistant text message (no finish tool)', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now, new FakeAgentServer(), terminalResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [
    { id: 'u0', kind: 'MessageEvent', source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    assistantMessage('a1', 'here is my answer'),
  ];

  const created = await coord.syncDeliveryOutbox(binding.conversationId);
  assert.equal(created, 1);
  const deliveries = store.listLaneWork(binding.laneKey, 'delivery');
  assert.equal(deliveries.length, 1);
  assert.equal((deliveries[0]!.payload as { text: string }).text, 'here is my answer');
});

test('terminalResponseExtractor still delivers a finish observation', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now, new FakeAgentServer(), terminalResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [finishObservation('f1', 'done via finish')];

  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 1);
  assert.equal((store.listLaneWork(binding.laneKey, 'delivery')[0]!.payload as { text: string }).text, 'done via finish');
});

test('terminalResponseExtractor does not deliver assistant messages that carry tool calls', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now, new FakeAgentServer(), terminalResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [
    assistantMessage('a1', 'let me run a tool', { tool_calls: [{ id: 't1', name: 'terminal', arguments: '{}' }] }),
  ];

  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 0);
  assert.equal(store.listLaneWork(binding.laneKey, 'delivery').length, 0);
});

test('terminalResponseExtractor ignores user messages', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now, new FakeAgentServer(), terminalResponseExtractor);
  const binding = await coord.resolveLane(lane());
  agent.events = [
    { id: 'u0', kind: 'MessageEvent', source: 'user', llm_message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  ];

  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 0);
});

test('syncDeliveryOutbox creates one delivery per send_message action and is idempotent on replay', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now);
  const binding = await coord.resolveLane(lane());
  agent.events = [
    { id: 'e0', kind: 'MessageEvent' }, // not deliverable
    sendAction('e1', 'first reply'),
    sendAction('e2', 'second reply'),
  ];

  const created = await coord.syncDeliveryOutbox(binding.conversationId);
  assert.equal(created, 2);
  const deliveries = store.listLaneWork(binding.laneKey, 'delivery');
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries.map((d) => (d.payload as { text: string }).text), ['first reply', 'second reply']);

  // Replay from the advanced cursor → nothing new.
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 0);
  assert.equal(store.listLaneWork(binding.laneKey, 'delivery').length, 2);

  // A new event after the cursor is picked up.
  agent.events.push(sendAction('e3', 'third reply'));
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 1);
});

test('syncDeliveryOutbox paginates across multiple pages', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now); // outboxSyncPageSize = 2
  const binding = await coord.resolveLane(lane());
  agent.events = [sendAction('e1', 'a'), sendAction('e2', 'b'), sendAction('e3', 'c'), sendAction('e4', 'd'), sendAction('e5', 'e')];
  const created = await coord.syncDeliveryOutbox(binding.conversationId);
  assert.equal(created, 5);
  assert.equal(store.listLaneWork(binding.laneKey, 'delivery').length, 5);
});

test('projected delivery work respects lane order and joins back to the agent event', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now);
  const binding = await coord.resolveLane(lane());
  agent.events = [sendAction('e1', 'a'), sendAction('e2', 'b')];
  await coord.syncDeliveryOutbox(binding.conversationId);

  const first = store.claimReady('deliverer', c.now(), 'delivery');
  assert.equal(first?.row.agentEventId, 'e1');
  // Second delivery waits behind the first unresolved one.
  assert.equal(store.claimReady('deliverer', c.now(), 'delivery'), null);
  store.markSending(first!, c.now());
  store.settle(first!, { kind: 'done', externalMessageId: 'slack-1' }, c.now());
  const second = store.claimReady('deliverer', c.now(), 'delivery');
  assert.equal(second?.row.agentEventId, 'e2');
});

test('syncDeliveryOutbox parks the cursor on a 404 and stops re-polling the absent conversation', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now);
  const binding = await coord.resolveLane(lane());
  agent.conversationAbsent = true;

  // First sync hits the 404, parks the cursor, and returns 0 without throwing.
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 0);
  assert.equal(store.isProjectionCursorParked(binding.conversationId), true);
  assert.equal(agent.searchCalls, 1);

  // Subsequent ticks skip the parked conversation entirely — no more searchEvents calls, no spin.
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 0);
  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 0);
  assert.equal(agent.searchCalls, 1);
});

test('un-parking a cursor resumes delivery sync from where it left off', async () => {
  const c = clock();
  const { store, coord, agent } = makeCoordinator(c.now);
  const binding = await coord.resolveLane(lane());

  agent.conversationAbsent = true;
  await coord.syncDeliveryOutbox(binding.conversationId);
  assert.equal(store.isProjectionCursorParked(binding.conversationId), true);

  // The conversation comes back; a reconciliation un-parks it and sync resumes.
  agent.conversationAbsent = false;
  agent.events = [sendAction('e1', 'back online')];
  store.unparkProjectionCursor(binding.conversationId, c.now());

  assert.equal(await coord.syncDeliveryOutbox(binding.conversationId), 1);
  assert.equal((store.listLaneWork(binding.laneKey, 'delivery')[0]!.payload as { text: string }).text, 'back online');
});

test('a non-404 sync error still propagates (retryable transient failure)', async () => {
  const c = clock();
  const { coord, agent } = makeCoordinator(c.now);
  const binding = await coord.resolveLane(lane());
  const original = agent.searchEvents.bind(agent);
  agent.searchEvents = async () => {
    const err = new Error('searchEvents failed: 503') as Error & { status?: number };
    err.status = 503;
    throw err;
  };

  await assert.rejects(() => coord.syncDeliveryOutbox(binding.conversationId), /503/);
  // Not parked — a transient error must remain retryable.
  agent.searchEvents = original;
  assert.equal(coord.workStore.isProjectionCursorParked(binding.conversationId), false);
});
