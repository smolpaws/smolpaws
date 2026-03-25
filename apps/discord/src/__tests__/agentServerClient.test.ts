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

test('dispatchToAgentServer keeps polling after a transient non-OK status response', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let pollAttempts = 0;

  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });

    if (url.endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'conv-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/conversations/conv-1')) {
      pollAttempts += 1;
      if (pollAttempts === 1) {
        return new Response('temporary failure', { status: 500 });
      }
      return new Response(JSON.stringify({ id: 'conv-1', execution_status: 'finished' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/outbound_messages/claim')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/events/search?')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              kind: 'MessageEvent',
              llm_message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done after retry' }],
              },
            },
          ],
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
    reply: 'done after retry',
    outboundMessages: [],
    conversationId: 'conv-1',
  });
  assert.equal(pollAttempts, 2);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://runner.example.com/api/conversations',
      'https://runner.example.com/api/conversations/conv-1',
      'https://runner.example.com/api/conversations/conv-1',
      'https://runner.example.com/api/conversations/conv-1/outbound_messages/claim',
      'https://runner.example.com/api/conversations/conv-1/events/search?kind=MessageEvent&source=agent&sort_order=TIMESTAMP_DESC&limit=20',
    ],
  );
});

test('dispatchToAgentServer keeps polling after a transient polling exception', async () => {
  let pollAttempts = 0;

  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'conv-2' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/conversations/conv-2')) {
      pollAttempts += 1;
      if (pollAttempts === 1) {
        throw new Error('socket hang up');
      }
      return new Response(JSON.stringify({ id: 'conv-2', execution_status: 'finished' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/outbound_messages/claim')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/events/search?')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              kind: 'MessageEvent',
              llm_message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done after exception' }],
              },
            },
          ],
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
    reply: 'done after exception',
    outboundMessages: [],
    conversationId: 'conv-2',
  });
  assert.equal(pollAttempts, 2);
});

test('dispatchToAgentServer sends the prompt through the events endpoint when reusing a conversation', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });

    if (url.endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'conv-3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/conversations/conv-3/events')) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/api/conversations/conv-3')) {
      return new Response(JSON.stringify({ id: 'conv-3', execution_status: 'finished' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.endsWith('/outbound_messages/claim')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/events/search?')) {
      return new Response(
        JSON.stringify({
          items: [
            {
              kind: 'MessageEvent',
              llm_message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'reply from reused conversation' }],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer({
    ...buildOptions(fetchStub),
    prompt: 'retry this request',
  });

  assert.deepEqual(result, {
    reply: 'reply from reused conversation',
    outboundMessages: [],
    conversationId: 'conv-3',
  });

  const eventsCall = calls.find((call) => call.url.endsWith('/api/conversations/conv-3/events'));
  assert(eventsCall);
  assert.equal(eventsCall.init?.method, 'POST');
  assert.equal(
    new Headers(eventsCall.init?.headers).get('authorization'),
    'Bearer secret-token',
  );
  assert.deepEqual(JSON.parse(String(eventsCall.init?.body)), {
    role: 'user',
    content: [{ type: 'text', text: 'retry this request' }],
    run: true,
  });
});
