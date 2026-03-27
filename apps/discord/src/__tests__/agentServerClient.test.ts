import assert from 'node:assert/strict';
import test from 'node:test';
import type { Logger } from 'pino';
import { dispatchToAgentServer } from '../agentServerClient.js';

function createLogger(): Logger {
  const noop = () => {};
  return {
    debug: noop,
    warn: noop,
  } as unknown as Logger;
}

function buildOptions(fetchImpl: typeof fetch) {
  return {
    baseUrl: 'https://runner.example.com',
    token: 'secret-token',
    conversationId: 'discord-thread-1',
    messageId: 'discord-message-1',
    prompt: 'please help',
    discord: {
      channel_id: '123',
      author_id: '456',
      author_name: 'engel',
    },
    logger: createLogger(),
    fetchImpl,
    sleepImpl: async () => {},
  };
}

test('dispatchToAgentServer submits a Discord turn and returns the final reply', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/api/conversations/discord-thread-1/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-1',
          message_event_id: 'msg-1',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (url.includes('/turns/turn-1?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-1',
          status: 'completed',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          completed_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
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
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-1',
          status: 'completed',
          reply: 'done via turn result',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(buildOptions(fetchStub));

  assert.deepEqual(result, {
    reply: 'done via turn result',
    outboundMessages: [],
    conversationId: 'discord-thread-1',
  });
  const submitBody = JSON.parse(String(calls[0]?.init?.body)) as {
    idempotency_key: string;
    user_message: { content: Array<{ text: string }> };
    create_conversation: {
      smolpaws: {
        ingress: string;
        enable_send_message: boolean;
      };
    };
  };
  assert.equal(submitBody.idempotency_key, 'discord-message-1');
  assert.equal(submitBody.user_message.content[0]?.text, 'please help');
  assert.equal(submitBody.create_conversation.smolpaws.ingress, 'discord');
  assert.equal(submitBody.create_conversation.smolpaws.enable_send_message, true);
});

test('dispatchToAgentServer does not fabricate a fallback reply for non-owner retries', async () => {
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/conversations/discord-thread-1/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-3',
          message_event_id: 'msg-3',
          started_new_turn: false,
          status: 'running',
          is_delivery_owner: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (url.includes('/turns/turn-3?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-3',
          status: 'running',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: false,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(buildOptions(fetchStub));

  assert.deepEqual(result, {
    outboundMessages: [],
    conversationId: 'discord-thread-1',
  });
});

test('dispatchToAgentServer preserves outbound messages alongside the final reply', async () => {
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/conversations/discord-thread-1/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-2',
          message_event_id: 'msg-2',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (url.includes('/turns/turn-2?delivery_owner_id=')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-2',
          status: 'completed',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          completed_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (url.endsWith('/turns/turn-2/outbound_messages/claim')) {
      return new Response(
        JSON.stringify([{ kind: 'current_thread_message', text: 'progress update' }]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (url.endsWith('/turns/turn-2/result')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'discord-thread-1',
          turn_id: 'turn-2',
          status: 'completed',
          reply: 'final answer',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(buildOptions(fetchStub));

  assert.deepEqual(result, {
    reply: 'final answer',
    outboundMessages: [{ kind: 'current_thread_message', text: 'progress update' }],
    conversationId: 'discord-thread-1',
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
