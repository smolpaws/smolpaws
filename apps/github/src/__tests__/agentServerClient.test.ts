import assert from 'node:assert/strict';
import test from 'node:test';
import type { SmolpawsQueueMessage } from '../../../../src/shared/github.js';
import { dispatchToAgentServer } from '../agentServerClient.js';

function buildMessage(body: string): SmolpawsQueueMessage {
  return {
    event: 'issue_comment',
    delivery_id: 'delivery-123',
    payload: {
      action: 'created',
      sender: { login: 'enyst', id: 1 },
      comment: { body, id: 42 },
      repository: {
        full_name: 'smolpaws/smolpaws',
        owner: { login: 'smolpaws' },
      },
      issue: { number: 20 },
      installation: { id: 123 },
    },
    meta: { ingress: 'github_webhook' },
  };
}

test('dispatchToAgentServer submits a turn and reads the final result from the turn API', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/api/conversations/github-smolpaws-smolpaws-20/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'github-smolpaws-smolpaws-20',
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
          conversation_id: 'github-smolpaws-smolpaws-20',
          turn_id: 'turn-1',
          status: 'completed',
          started_at: '2026-03-27T00:00:00.000Z',
          updated_at: '2026-03-27T00:00:01.000Z',
          completed_at: '2026-03-27T00:00:01.000Z',
          delivery_owner_id: 'owner-1',
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
          conversation_id: 'github-smolpaws-smolpaws-20',
          turn_id: 'turn-1',
          status: 'completed',
          reply: 'meow from turn result',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(
    buildMessage('@smolpaws fix the bug'),
    {
      SMOLPAWS_RUNNER_URL: 'https://runner.example.com/',
      SMOLPAWS_RUNNER_TOKEN: 'secret-token',
    },
    fetchStub,
  );

  assert.deepEqual(result, { reply: 'meow from turn result', outbound_messages: undefined });
  assert.equal(calls.length, 4);
  assert.equal(
    new Headers(calls[0]?.init?.headers).get('authorization'),
    'Bearer secret-token',
  );

  const submitBody = JSON.parse(String(calls[0]?.init?.body)) as {
    idempotency_key: string;
    delivery_owner_id: string;
    user_message: { content: Array<{ text: string }> };
    create_conversation: {
      max_iterations: number;
      agent: { tools: Array<{ name: string }> };
      smolpaws: {
        ingress: string;
        enable_send_message: boolean;
        github: {
          event: string;
          repository_full_name: string;
          owner_login: string;
          actor_login: string;
          issue_number: number;
        };
      };
    };
  };
  assert.equal(submitBody.idempotency_key, 'delivery-123');
  assert.equal(typeof submitBody.delivery_owner_id, 'string');
  assert.equal(submitBody.user_message.content[0]?.text, 'fix the bug');
  assert.equal(submitBody.create_conversation.max_iterations, 1000);
  assert.deepEqual(
    submitBody.create_conversation.agent.tools.map((tool) => tool.name),
    ['terminal', 'file_editor', 'task_tracker'],
  );
  assert.equal(submitBody.create_conversation.smolpaws.ingress, 'github_webhook');
  assert.equal(submitBody.create_conversation.smolpaws.enable_send_message, true);
  assert.deepEqual(submitBody.create_conversation.smolpaws.github, {
    event: 'issue_comment',
    repository_full_name: 'smolpaws/smolpaws',
    owner_login: 'smolpaws',
    actor_login: 'enyst',
    issue_number: 20,
  });
});

test('dispatchToAgentServer returns collapsed outbound messages and the final assistant reply', async () => {
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/conversations/github-smolpaws-smolpaws-20/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'github-smolpaws-smolpaws-20',
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
          conversation_id: 'github-smolpaws-smolpaws-20',
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
        JSON.stringify([
          { kind: 'current_thread_message', text: 'first' },
          { kind: 'current_thread_message', text: 'second' },
        ]),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    if (url.endsWith('/turns/turn-2/result')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'github-smolpaws-smolpaws-20',
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

  const result = await dispatchToAgentServer(
    buildMessage('@smolpaws answer here'),
    { SMOLPAWS_RUNNER_URL: 'https://runner.example.com' },
    fetchStub,
  );

  assert.deepEqual(result, {
    reply: 'final answer',
    outbound_messages: [
      { kind: 'current_thread_message', text: 'first\n\nsecond' },
    ],
  });
});

test('dispatchToAgentServer does not post a warm-up fallback for non-owner retries', async () => {
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/conversations/github-smolpaws-smolpaws-20/turns')) {
      return new Response(
        JSON.stringify({
          conversation_id: 'github-smolpaws-smolpaws-20',
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
          conversation_id: 'github-smolpaws-smolpaws-20',
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

  const result = await dispatchToAgentServer(
    buildMessage('@smolpaws answer here'),
    { SMOLPAWS_RUNNER_URL: 'https://runner.example.com' },
    fetchStub,
  );

  assert.deepEqual(result, {
    reply: undefined,
    outbound_messages: undefined,
  });
});

test('dispatchToAgentServer returns a fallback reply without calling the runner when the mention has no prompt', async () => {
  let called = false;
  const fetchStub: typeof fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  const result = await dispatchToAgentServer(
    buildMessage('@smolpaws'),
    { SMOLPAWS_RUNNER_URL: 'https://runner.example.com' },
    fetchStub,
  );

  assert.deepEqual(result, {
    reply:
      '🐾 Hey enyst! smolpaws is warming up in smolpaws/smolpaws.\nRequest: (none)',
  });
  assert.equal(called, false);
});

test('dispatchToAgentServer rejects a legacy /run runner URL', async () => {
  let called = false;
  const fetchStub: typeof fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  await assert.rejects(
    dispatchToAgentServer(
      buildMessage('@smolpaws say meow'),
      { SMOLPAWS_RUNNER_URL: 'https://runner.example.com/run/' },
      fetchStub,
    ),
    /must not end with \/run/,
  );
  assert.equal(called, false);
});
