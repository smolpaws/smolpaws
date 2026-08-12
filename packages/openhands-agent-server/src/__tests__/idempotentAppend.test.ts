/**
 * Integration tests for the additive idempotent `event_id` on `POST /events`, exercised against the real
 * in-process Fastify app (`createAgentServerApp`). Proves the append-response-loss window is closed: a
 * caller that appends with an `event_id`, loses the response, and re-appends the same `event_id` gets
 * `created:false` and does NOT create a duplicate user turn — including across a server restart and around
 * a real (TestLLM) agent run. This is the ADR §8 server delta the external message-work coordinator relies
 * on for effectively-once intake.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, FinishTool, InMemorySecretStore, TestLLM, textContent } from '@smolpaws/openhands-agent';
import { describe, expect, test } from 'vitest';

import { createAgentServerApp } from '../app.js';

const EVENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Minimal agent that immediately calls `finish` via a deterministic TestLLM (no live credentials). */
function finishAgentFactory() {
  return new Agent({
    llm: TestLLM.fromMessages([
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'finish-call-1', name: 'finish', arguments: JSON.stringify({ message: 'done' }), origin: 'completion' }],
      },
    ]),
    tools: [FinishTool.create()],
  });
}

async function userMessages(app: Awaited<ReturnType<typeof createAgentServerApp>>['app'], conversationId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/api/conversations/${conversationId}/events/search?kind=MessageEvent&source=user&sort_order=TIMESTAMP`,
  });
  return res.json<{ items: Array<{ id: string; kind: string; source: string }> }>().items;
}

describe('POST /events idempotent event_id', () => {
  test('re-appending the same event_id returns created:false and does not duplicate the turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-idem-'));
    const { app } = await createAgentServerApp({ config: { conversationsPath: root }, secretStore: new InMemorySecretStore() });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;

      // First append: creates the event under the caller-supplied id.
      const first = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/events`,
        payload: { role: 'user', content: [textContent('ship it')], run: false, event_id: EVENT_ID },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ success: true, event_id: EVENT_ID, created: true });

      // Response "lost" → the caller retries the exact same append. Must be an idempotent no-op.
      const retry = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/events`,
        payload: { role: 'user', content: [textContent('ship it')], run: false, event_id: EVENT_ID },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ success: true, event_id: EVENT_ID, created: false });

      const messages = await userMessages(app, id);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe(EVENT_ID);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('two concurrent appends with the same event_id: exactly one created, one event persisted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-idem-race-'));
    const { app } = await createAgentServerApp({ config: { conversationsPath: root }, secretStore: new InMemorySecretStore() });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;

      // Fire two identical same-event_id appends at once. They race the check-then-append: EventLog
      // serializes and one loses with DuplicateEventError, which must surface as an idempotent replay
      // (created:false), not a 500.
      const payload = { role: 'user', content: [textContent('race')], run: false, event_id: EVENT_ID };
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload }),
        app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload }),
      ]);

      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      const created = [a.json<{ created: boolean }>().created, b.json<{ created: boolean }>().created];
      expect(created.filter((c) => c === true)).toHaveLength(1); // exactly one winner
      expect(created.filter((c) => c === false)).toHaveLength(1); // exactly one idempotent replay
      expect(a.json<{ event_id: string }>().event_id).toBe(EVENT_ID);
      expect(b.json<{ event_id: string }>().event_id).toBe(EVENT_ID);

      const messages = await userMessages(app, id);
      expect(messages).toHaveLength(1); // only ONE event persisted
      expect(messages[0]?.id).toBe(EVENT_ID);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('idempotency survives a server restart (durable via the on-disk EventLog)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-idem-restart-'));
    const convId = '11111111-1111-4111-8111-111111111111';
    try {
      const first = await createAgentServerApp({ config: { conversationsPath: root }, secretStore: new InMemorySecretStore() });
      await first.app.inject({ method: 'POST', url: '/api/conversations', payload: { id: convId } });
      const created = await first.app.inject({
        method: 'POST',
        url: `/api/conversations/${convId}/events`,
        payload: { role: 'user', content: [textContent('persist me')], run: false, event_id: EVENT_ID },
      });
      expect(created.json<{ created: boolean }>().created).toBe(true);
      await first.app.close();

      // Restart: a fresh app instance on the same persistence root re-appends the same id.
      const second = await createAgentServerApp({ config: { conversationsPath: root } });
      const retry = await second.app.inject({
        method: 'POST',
        url: `/api/conversations/${convId}/events`,
        payload: { role: 'user', content: [textContent('persist me')], run: false, event_id: EVENT_ID },
      });
      expect(retry.json()).toEqual({ success: true, event_id: EVENT_ID, created: false });
      expect(await userMessages(second.app, convId)).toHaveLength(1);
      await second.app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('idempotent re-append holds around a real agent run (TestLLM), no duplicate user turn', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-idem-run-'));
    const { app } = await createAgentServerApp({ agentFactory: finishAgentFactory, config: { conversationsPath: root } });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;

      // Append with run:true — the agent executes to `finish`.
      const first = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/events`,
        payload: { role: 'user', content: [textContent('finish please')], run: true, event_id: EVENT_ID },
      });
      expect(first.json<{ created: boolean }>().created).toBe(true);

      await expect
        .poll(async () => (await app.inject({ method: 'GET', url: `/api/conversations/${id}` })).json<{ execution_status: string }>().execution_status)
        .toBe('finished');

      // A retry of the same intake after the run must not add a second user turn.
      const retry = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/events`,
        payload: { role: 'user', content: [textContent('finish please')], run: false, event_id: EVENT_ID },
      });
      expect(retry.json()).toEqual({ success: true, event_id: EVENT_ID, created: false });
      expect(await userMessages(app, id)).toHaveLength(1);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('omitting event_id preserves upstream behavior: each append is a new event', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oh-idem-plain-'));
    const { app } = await createAgentServerApp({ config: { conversationsPath: root }, secretStore: new InMemorySecretStore() });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;

      const a = await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('hi')], run: false } });
      const b = await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('hi')], run: false } });
      const bodyA = a.json<{ event_id: string; created: boolean }>();
      const bodyB = b.json<{ event_id: string; created: boolean }>();

      expect(bodyA.created).toBe(true);
      expect(bodyB.created).toBe(true);
      expect(bodyA.event_id).not.toBe(bodyB.event_id); // server-assigned distinct ids
      expect(await userMessages(app, id)).toHaveLength(2);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
