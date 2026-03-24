import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { initDatabase } from '../db.js';
import type { ExecutionScope } from '../scope.js';
import { runLocalAgentServerAgent } from './local-agent-server.js';

const TEST_SCOPE: ExecutionScope = {
  kind: 'whatsapp',
  scopeId: 'main',
  name: 'Main',
  workspaceFolder: 'main',
  chatJid: '46720459794@s.whatsapp.net',
  trigger: '@Andy',
  isControlScope: true,
};

function buildFetchStub(handlers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const matchingEntry = Object.entries(handlers)
      .sort((left, right) => right[0].length - left[0].length)
      .find(([key]) => url.includes(key));
    if (!matchingEntry) {
      throw new Error(`unexpected fetch ${url} (${init?.method ?? 'GET'})`);
    }
    return await matchingEntry[1]();
  };
}

test('runLocalAgentServerAgent creates a conversation rooted in the scope group directory', async () => {
  initDatabase();
  process.env.RUNNER_HOST = '127.0.0.1';
  process.env.PORT = '8788';
  delete process.env.SMOLPAWS_RUNNER_URL;

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/ready')) {
      return new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'wa-main-conv' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/task_commands/claim')) {
      return new Response(JSON.stringify([]), {
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
                content: [{ type: 'text', text: 'meow from local runner' }],
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

  try {
    const result = await runLocalAgentServerAgent(TEST_SCOPE, {
      prompt: '<messages><message>hi</message></messages>',
      conversationId: 'wa-main-conv',
      scopeId: TEST_SCOPE.scopeId,
      chatJid: TEST_SCOPE.chatJid,
      isControlScope: TEST_SCOPE.isControlScope,
    });

    assert.deepEqual(result, {
      status: 'success',
      result: 'meow from local runner',
      conversationId: 'wa-main-conv',
    });

    assert.equal(calls[0]?.url, 'http://127.0.0.1:8788/ready');
    const createCall = calls.find((call) => call.url.endsWith('/api/conversations'));
    assert.ok(createCall);
    const body = JSON.parse(String(createCall.init?.body)) as {
      workspace: { kind: string; working_dir: string };
      smolpaws: { ingress: string; scope_id: string; enable_send_message: boolean; enable_task_tools: boolean };
      agent: { tools: Array<{ name: string }> };
      conversation_id: string;
      max_iterations: number;
    };

    assert.equal(body.workspace.kind, 'local');
    assert.equal(body.workspace.working_dir, path.join(process.cwd(), 'groups', 'main'));
    assert.equal(body.smolpaws.ingress, 'whatsapp');
    assert.equal(body.smolpaws.scope_id, 'main');
    assert.equal(body.smolpaws.enable_send_message, true);
    assert.equal(body.smolpaws.enable_task_tools, true);
    assert.deepEqual(body.agent.tools.map((tool) => tool.name), [
      'terminal',
      'file_editor',
      'task_tracker',
    ]);
    assert.equal(body.conversation_id, 'wa-main-conv');
    assert.equal(body.max_iterations, 5000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runLocalAgentServerAgent returns outbound messages without forcing a final reply', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchStub({
    '/ready': () =>
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/api/conversations': () =>
      new Response(JSON.stringify({ id: 'wa-outbound-conv' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/outbound_messages/claim': () =>
      new Response(
        JSON.stringify([{ kind: 'current_thread_message', text: 'hello from send_message' }]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });

  try {
    const result = await runLocalAgentServerAgent(TEST_SCOPE, {
      prompt: 'say hello',
      scopeId: TEST_SCOPE.scopeId,
      chatJid: TEST_SCOPE.chatJid,
      isControlScope: TEST_SCOPE.isControlScope,
    });

    assert.deepEqual(result, {
      status: 'success',
      result: null,
      conversationId: 'wa-outbound-conv',
      outboundMessages: [{ kind: 'current_thread_message', text: 'hello from send_message' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SMOLPAWS_RUNNER_URL;
  }
});

test('runLocalAgentServerAgent fails fast on a legacy /run runner url', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'https://runner.example.com/run/';

  const result = await runLocalAgentServerAgent(TEST_SCOPE, {
    prompt: 'say hello',
    scopeId: TEST_SCOPE.scopeId,
    chatJid: TEST_SCOPE.chatJid,
    isControlScope: TEST_SCOPE.isControlScope,
  });

  assert.equal(result.status, 'error');
  assert.match(result.error ?? '', /must not end with \/run/);

  delete process.env.SMOLPAWS_RUNNER_URL;
});

test('runLocalAgentServerAgent starts a fresh conversation when the previous one is exhausted', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  const conversationBodies: Array<{ conversation_id?: string; max_iterations: number }> = [];
  const eventResponses = [
    {
      items: [
        {
          kind: 'ConversationErrorEvent',
          code: 'max_iterations_exceeded',
          detail: 'Agent reached the maximum iteration limit (100).',
        },
      ],
    },
    {
      items: [
        {
          kind: 'MessageEvent',
          llm_message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'fresh conversation reply' }],
          },
        },
      ],
    },
  ];
  let createCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/ready')) {
      return new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/api/conversations')) {
      const body = JSON.parse(String(init?.body)) as { conversation_id?: string; max_iterations: number };
      conversationBodies.push(body);
      createCount += 1;
      return new Response(JSON.stringify({ id: createCount === 1 ? 'stale-conv' : 'fresh-conv' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/task_commands/claim')) {
      return new Response(JSON.stringify([]), {
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
      const next = eventResponses.shift();
      if (!next) {
        throw new Error('unexpected extra events/search request');
      }
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await runLocalAgentServerAgent(TEST_SCOPE, {
      prompt: 'continue please',
      conversationId: 'stale-conv',
      scopeId: TEST_SCOPE.scopeId,
      chatJid: TEST_SCOPE.chatJid,
      isControlScope: TEST_SCOPE.isControlScope,
    });

    assert.deepEqual(result, {
      status: 'success',
      result: 'fresh conversation reply',
      conversationId: 'fresh-conv',
    });
    assert.equal(conversationBodies.length, 2);
    assert.equal(conversationBodies[0]?.conversation_id, 'stale-conv');
    assert.equal(conversationBodies[1]?.conversation_id, undefined);
    assert.equal(conversationBodies[0]?.max_iterations, 5000);
    assert.equal(conversationBodies[1]?.max_iterations, 5000);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SMOLPAWS_RUNNER_URL;
  }
});
