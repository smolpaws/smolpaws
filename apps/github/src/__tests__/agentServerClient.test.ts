import assert from 'node:assert/strict';
import test from 'node:test';
import type { SmolpawsQueueMessage } from '../../../agent-server/src/shared/github.js';
import { dispatchToAgentServer } from '../agentServerClient.js';

function buildMessage(body: string): SmolpawsQueueMessage {
  return {
    event: 'issue_comment',
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

test('dispatchToAgentServer creates a conversation, claims outbound messages, then falls back to events search', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchStub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'github-smolpaws-smolpaws-20' }), {
        status: 201,
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
                content: [{ type: 'text', text: 'meow from events' }],
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

  const result = await dispatchToAgentServer(
    buildMessage('@smolpaws fix the bug'),
    {
      SMOLPAWS_RUNNER_URL: 'https://runner.example.com/',
      SMOLPAWS_RUNNER_TOKEN: 'secret-token',
    },
    fetchStub,
  );

  assert.deepEqual(result, { reply: 'meow from events' });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.url, 'https://runner.example.com/api/conversations');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(
    new Headers(calls[0]?.init?.headers).get('authorization'),
    'Bearer secret-token',
  );

  const createBody = JSON.parse(String(calls[0]?.init?.body)) as {
    conversation_id: string;
    initial_message: { content: Array<{ text: string }> };
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
        pull_request_number?: number;
      };
    };
  };
  assert.equal(createBody.conversation_id, 'github-smolpaws-smolpaws-20');
  assert.deepEqual(
    createBody.agent.tools.map((tool) => tool.name),
    ['terminal', 'file_editor', 'task_tracker'],
  );
  assert.equal(createBody.initial_message.content[0]?.text, 'fix the bug');
  assert.equal(createBody.smolpaws.ingress, 'github_webhook');
  assert.equal(createBody.smolpaws.enable_send_message, true);
  assert.deepEqual(createBody.smolpaws.github, {
    event: 'issue_comment',
    repository_full_name: 'smolpaws/smolpaws',
    owner_login: 'smolpaws',
    actor_login: 'enyst',
    issue_number: 20,
  });

  assert.equal(
    calls[1]?.url,
    'https://runner.example.com/api/conversations/github-smolpaws-smolpaws-20/outbound_messages/claim',
  );
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.equal(
    calls[2]?.url,
    'https://runner.example.com/api/conversations/github-smolpaws-smolpaws-20/events/search?kind=MessageEvent&source=agent&sort_order=timestamp_desc&limit=20',
  );
});

test('dispatchToAgentServer returns collapsed outbound messages without fetching events', async () => {
  const calls: string[] = [];
  const fetchStub: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.endsWith('/api/conversations')) {
      return new Response(JSON.stringify({ id: 'conv-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/outbound_messages/claim')) {
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
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await dispatchToAgentServer(
    buildMessage('@smolpaws answer here'),
    { SMOLPAWS_RUNNER_URL: 'https://runner.example.com' },
    fetchStub,
  );

  assert.deepEqual(result, {
    reply:
      '🐾 Hey enyst! smolpaws is warming up in smolpaws/smolpaws.\nRequest: "answer here"',
    outbound_messages: [
      { kind: 'current_thread_message', text: 'first\n\nsecond' },
    ],
  });
  assert.equal(calls.length, 2);
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
