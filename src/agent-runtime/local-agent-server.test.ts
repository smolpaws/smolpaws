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

function buildFetchStub(
  handlers: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entries = Object.entries(handlers).sort((left, right) => right[0].length - left[0].length);
    const exactOrSuffixMatch = entries.find(([key]) => url === key || url.endsWith(key));
    if (exactOrSuffixMatch) {
      return await exactOrSuffixMatch[1](url, init);
    }

    const substringMatches = entries
      .map(([key, handler]) => ({ key, handler, index: url.indexOf(key) }))
      .filter((match) => match.index !== -1)
      .sort((left, right) => {
        if (right.index !== left.index) {
          return right.index - left.index;
        }
        return right.key.length - left.key.length;
      });

    const matchingEntry = substringMatches[0];
    if (!matchingEntry) {
      throw new Error(`unexpected fetch ${url} (${init?.method ?? 'GET'})`);
    }
    return await matchingEntry.handler(url, init);
  };
}

test('runLocalAgentServerAgent submits a turn rooted in the scope group directory', async () => {
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
    if (url.endsWith('/api/conversations/wa-main-conv/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'wa-main-conv',
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
          conversation_id: 'wa-main-conv',
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
    if (url.endsWith('/turns/turn-1/task_commands/claim')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
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
          conversation_id: 'wa-main-conv',
          turn_id: 'turn-1',
          status: 'completed',
          reply: 'meow from local runner',
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
      messageId: 'wa-msg-1',
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
    const submitCall = calls.find((call) =>
      call.url.endsWith('/api/conversations/wa-main-conv/turns'),
    );
    assert.ok(submitCall);
    const body = JSON.parse(String(submitCall.init?.body)) as {
      idempotency_key: string;
      user_message: { content: Array<{ text?: string }> };
      create_conversation: {
        workspace: { kind: string; working_dir: string };
        smolpaws: {
          ingress: string;
          scope_id: string;
          enable_send_message: boolean;
          enable_task_tools: boolean;
        };
        agent: { tools: Array<{ name: string }> };
        confirmation_policy: { kind: string };
        conversation_id: string;
        max_iterations: number;
      };
    };

    assert.equal(body.idempotency_key, 'wa-msg-1');
    assert.equal(body.create_conversation.workspace.kind, 'local');
    assert.equal(
      body.create_conversation.workspace.working_dir,
      path.join(process.cwd(), 'groups', 'main'),
    );
    assert.equal(body.create_conversation.smolpaws.ingress, 'whatsapp');
    assert.equal(body.create_conversation.smolpaws.scope_id, 'main');
    assert.equal(body.create_conversation.smolpaws.enable_send_message, true);
    assert.equal(body.create_conversation.smolpaws.enable_task_tools, true);
    assert.equal(body.create_conversation.confirmation_policy.kind, 'NeverConfirm');
    assert.deepEqual(
      body.create_conversation.agent.tools.map((tool) => tool.name),
      ['terminal', 'file_editor', 'task_tracker'],
    );
    assert.equal(body.create_conversation.conversation_id, 'wa-main-conv');
    assert.equal(body.create_conversation.max_iterations, 5000);
    assert.equal(
      body.user_message.content[0]?.text,
      '<messages><message>hi</message></messages>',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runLocalAgentServerAgent preserves outbound messages alongside the final reply', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchStub({
    '/ready': () =>
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/api/conversations/main-': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-outbound-conv',
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
      ),
    '/turns/turn-2?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-outbound-conv',
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
      ),
    '/turns/turn-2/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-2/outbound_messages/claim': () =>
      new Response(
        JSON.stringify([{ kind: 'current_thread_message', text: 'hello from send_message' }]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-2/result': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-outbound-conv',
          turn_id: 'turn-2',
          status: 'completed',
          reply: 'final reply',
        }),
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
      result: 'final reply',
      conversationId: 'wa-outbound-conv',
      outboundMessages: [{ kind: 'current_thread_message', text: 'hello from send_message' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SMOLPAWS_RUNNER_URL;
  }
});

test('runLocalAgentServerAgent retries a transient fetch failure when claiming outbound messages', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  let outboundClaimAttempts = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchStub({
    '/ready': () =>
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/api/conversations/main-': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-retry-conv',
          turn_id: 'turn-3',
          message_event_id: 'msg-3',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-3?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-retry-conv',
          turn_id: 'turn-3',
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
      ),
    '/turns/turn-3/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-3/outbound_messages/claim': () => {
      outboundClaimAttempts += 1;
      if (outboundClaimAttempts === 1) {
        throw new Error('fetch failed');
      }
      return new Response(
        JSON.stringify([{ kind: 'current_thread_message', text: 'recovered after retry' }]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    '/turns/turn-3/result': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-retry-conv',
          turn_id: 'turn-3',
          status: 'completed',
        }),
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
      conversationId: 'wa-retry-conv',
      outboundMessages: [{ kind: 'current_thread_message', text: 'recovered after retry' }],
    });
    assert.equal(outboundClaimAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SMOLPAWS_RUNNER_URL;
  }
});

test('runLocalAgentServerAgent treats confirmation-required turns as errors for client ingress', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchStub({
    '/ready': () =>
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/api/conversations/main-': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-confirm-conv',
          turn_id: 'turn-confirm',
          message_event_id: 'msg-confirm',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-confirm?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'wa-confirm-conv',
          turn_id: 'turn-confirm',
          status: 'waiting_for_confirmation',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          completed_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-confirm/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-confirm/outbound_messages/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-confirm/result': () =>
      new Response(
        JSON.stringify({}),
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

    assert.equal(result.status, 'error');
    assert.equal(result.conversationId, 'wa-confirm-conv');
    assert.equal(result.result, null);
    assert.equal(
      result.error,
      'Runner requested confirmation, but SmolPaws clients cannot surface confirmation prompts.',
    );
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

test('runLocalAgentServerAgent starts fresh after max_iterations_exceeded on a reused conversation', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  const submitBodies: Array<{ create_conversation: { conversation_id?: string } }> = [];
  let submitCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchStub({
    '/ready': () =>
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/api/conversations/reused-conv/turns': (_url, init) => {
      submitBodies.push(JSON.parse(String(init?.body)));
      submitCount += 1;
      return new Response(
        JSON.stringify({
          conversation_id: 'reused-conv',
          turn_id: 'turn-4',
          message_event_id: 'msg-4',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    '/api/conversations/main-': (_url, init) => {
      submitBodies.push(JSON.parse(String(init?.body)));
      submitCount += 1;
      return new Response(
        JSON.stringify({
          conversation_id: 'fresh-conv',
          turn_id: 'turn-5',
          message_event_id: 'msg-5',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    '/turns/turn-4?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'reused-conv',
          turn_id: 'turn-4',
          status: 'error',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          completed_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-4/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-4/outbound_messages/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-4/result': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'reused-conv',
          turn_id: 'turn-4',
          status: 'error',
          error_code: 'max_iterations_exceeded',
          error_detail: 'Agent hit the iteration cap',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-5?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'fresh-conv',
          turn_id: 'turn-5',
          status: 'completed',
          started_at: '2026-03-27T00:00:02.000Z',
          updated_at: '2026-03-27T00:00:03.000Z',
          completed_at: '2026-03-27T00:00:03.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-5/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-5/outbound_messages/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-5/result': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'fresh-conv',
          turn_id: 'turn-5',
          status: 'completed',
          reply: 'fresh reply',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });

  try {
    const result = await runLocalAgentServerAgent(TEST_SCOPE, {
      prompt: 'continue please',
      conversationId: 'reused-conv',
      scopeId: TEST_SCOPE.scopeId,
      chatJid: TEST_SCOPE.chatJid,
      isControlScope: TEST_SCOPE.isControlScope,
    });

    assert.deepEqual(result, {
      status: 'success',
      result: 'fresh reply',
      conversationId: 'fresh-conv',
    });
    assert.equal(submitCount, 2);
    assert.equal(submitBodies[0]?.create_conversation.conversation_id, 'reused-conv');
    assert.equal(submitBodies[1]?.create_conversation.conversation_id, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SMOLPAWS_RUNNER_URL;
  }
});

test('runLocalAgentServerAgent starts fresh after budget_exceeded on a reused conversation', async () => {
  initDatabase();
  process.env.SMOLPAWS_RUNNER_URL = 'http://127.0.0.1:8788';

  const submitBodies: Array<{ create_conversation: { conversation_id?: string } }> = [];
  let submitCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = buildFetchStub({
    '/ready': () =>
      new Response(JSON.stringify({ status: 'ready' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/api/conversations/reused-budget-conv/turns': (_url, init) => {
      submitBodies.push(JSON.parse(String(init?.body)));
      submitCount += 1;
      return new Response(
        JSON.stringify({
          conversation_id: 'reused-budget-conv',
          turn_id: 'turn-6',
          message_event_id: 'msg-6',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    '/api/conversations/main-': (_url, init) => {
      submitBodies.push(JSON.parse(String(init?.body)));
      submitCount += 1;
      return new Response(
        JSON.stringify({
          conversation_id: 'fresh-budget-conv',
          turn_id: 'turn-7',
          message_event_id: 'msg-7',
          started_new_turn: true,
          status: 'running',
          is_delivery_owner: true,
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    '/turns/turn-6?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'reused-budget-conv',
          turn_id: 'turn-6',
          status: 'error',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          completed_at: '2026-03-27T00:00:01.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-6/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-6/outbound_messages/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-6/result': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'reused-budget-conv',
          turn_id: 'turn-6',
          status: 'error',
          error_code: 'llm_bad_request',
          error_detail:
            'LLM request failed (400): {"error":{"message":"Budget has been exceeded! Current cost: 1002.1, Max budget: 1000.0","type":"budget_exceeded"}}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-7?delivery_owner_id=': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'fresh-budget-conv',
          turn_id: 'turn-7',
          status: 'completed',
          started_at: '2026-03-27T00:00:02.000Z',
          updated_at: '2026-03-27T00:00:03.000Z',
          completed_at: '2026-03-27T00:00:03.000Z',
          is_delivery_owner: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    '/turns/turn-7/task_commands/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-7/outbound_messages/claim': () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    '/turns/turn-7/result': () =>
      new Response(
        JSON.stringify({
          conversation_id: 'fresh-budget-conv',
          turn_id: 'turn-7',
          status: 'completed',
          reply: 'fresh reply after budget reset',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });

  try {
    const result = await runLocalAgentServerAgent(TEST_SCOPE, {
      prompt: 'continue please',
      conversationId: 'reused-budget-conv',
      scopeId: TEST_SCOPE.scopeId,
      chatJid: TEST_SCOPE.chatJid,
      isControlScope: TEST_SCOPE.isControlScope,
    });

    assert.deepEqual(result, {
      status: 'success',
      result: 'fresh reply after budget reset',
      conversationId: 'fresh-budget-conv',
    });
    assert.equal(submitCount, 2);
    assert.equal(submitBodies[0]?.create_conversation.conversation_id, 'reused-budget-conv');
    assert.equal(submitBodies[1]?.create_conversation.conversation_id, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.SMOLPAWS_RUNNER_URL;
  }
});
