import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from 'pino';
import { dispatchToAgentServer } from '../agentServerClient.js';

function createLogger(): Logger {
  const noop = () => {};
  return { debug: noop, warn: noop } as unknown as Logger;
}

function buildOptions(fetchImpl: typeof fetch) {
  return {
    baseUrl: 'https://runner.example.com',
    token: 'secret-token',
    conversationId: 'slack-thread-T06P-C123-1717200000.000100',
    messageId: 'C123:1717200000.000100',
    prompt: 'please help',
    slack: {
      team_id: 'T06P',
      channel_id: 'C123',
      user_id: 'U456',
      thread_ts: '1717200000.000100',
    },
    logger: createLogger(),
    fetchImpl,
    sleepImpl: async () => {},
  };
}

test('dispatchToAgentServer submits a Slack turn and returns the final reply', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const convId = 'slack-thread-T06P-C123-1717200000.000100';

  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith(`/api/conversations/${convId}/turns`)) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-1',
          message_event_id: 'msg-1',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/turns/turn-1?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-1',
          status: 'completed',
          started_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:01.000Z',
          completed_at: '2026-06-01T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/turns/turn-1/outbound_messages/claim')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/turns/turn-1/result')) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-1',
          status: 'completed',
          reply: 'Here you go!',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(buildOptions(fetchStub));

  assert.equal(result.reply, 'Here you go!');
  assert.deepEqual(result.outboundMessages, []);
  assert.equal(result.conversationId, convId);

  const submitCall = calls.find((c) => c.url.endsWith('/turns'));
  assert.ok(submitCall);
  const body = JSON.parse(submitCall.init?.body as string);
  assert.equal(body.create_conversation.smolpaws.ingress, 'slack');
  assert.equal(body.create_conversation.smolpaws.slack.team_id, 'T06P');
  assert.equal(body.create_conversation.smolpaws.slack.channel_id, 'C123');
});

test('dispatchToAgentServer preserves outbound messages alongside the final reply', async () => {
  const convId = 'slack-thread-T06P-C123-1717200000.000100';

  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(`/api/conversations/${convId}/turns`)) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-2',
          message_event_id: 'msg-2',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/turns/turn-2?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-2',
          status: 'completed',
          started_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:01.000Z',
          completed_at: '2026-06-01T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/turns/turn-2/outbound_messages/claim')) {
      return new Response(
        JSON.stringify([{ kind: 'current_thread_message', text: 'progress update' }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith('/turns/turn-2/result')) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-2',
          status: 'completed',
          reply: 'final answer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(buildOptions(fetchStub));

  assert.equal(result.reply, 'final answer');
  assert.deepEqual(result.outboundMessages, [
    { kind: 'current_thread_message', text: 'progress update' },
  ]);
});

test('dispatchToAgentServer does not fabricate a reply for non-owner', async () => {
  const convId = 'slack-thread-T06P-C123-1717200000.000100';

  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(`/api/conversations/${convId}/turns`)) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-3',
          message_event_id: 'msg-3',
          started_new_turn: false,
          status: 'running',
          is_delivery_owner: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/turns/turn-3?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: convId,
          turn_id: 'turn-3',
          status: 'running',
          started_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:01.000Z',
          is_delivery_owner: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(buildOptions(fetchStub));

  assert.deepEqual(result, {
    outboundMessages: [],
    conversationId: convId,
  });
});

test('dispatchToAgentServer rejects a legacy /run runner URL', async () => {
  await assert.rejects(
    dispatchToAgentServer({
      ...buildOptions(async () => {
        throw new Error('should not be called');
      }),
      baseUrl: 'https://runner.example.com/run/',
    }),
    /must not end with \/run/,
  );
});
