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
import { MessageRelay } from './messageRelay.js';
import { deterministicEventId } from './ids.js';
import { MessageWorkStore } from './store.js';
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

  async searchEvents(
    _conversationId: string,
    pageId: string | null,
    limit: number,
  ): Promise<{ items: AgentEvent[]; nextPageId: string | null }> {
    const start = pageId === null ? 0 : Math.max(0, Number.parseInt(pageId, 10) || 0);
    const items = this.events.slice(start, start + limit);
    const nextPageId = start + limit < this.events.length ? String(start + limit) : null;
    return { items, nextPageId };
  }
}

function makeCoordinator(now: () => number, agent = new FakeAgentServer()) {
  const store = new MessageWorkStore(new Database(tempDbPath()), POLICY);
  const coord = new MessageRelay(store, agent, { now, outboxSyncPageSize: 2 });
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
  agent.appended.set(`${work.conversationId}:${work.agentEventId}`, {
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
