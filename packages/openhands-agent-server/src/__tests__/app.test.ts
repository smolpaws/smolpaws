import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { Agent, FinishTool, TestLLM, textContent } from '@smolpaws/openhands-agent';

import { createAgentServerApp } from '../app.js';
import { generateOpenApiSchema } from '../openapi.js';

function agentFactory() {
  return new Agent({
    llm: TestLLM.fromMessages([
      {
        role: 'assistant',
        content: [],
        tool_calls: [
          {
            id: 'finish-call-1',
            name: 'finish',
            arguments: JSON.stringify({ message: 'done' }),
            origin: 'completion',
          },
        ],
      },
    ]),
    tools: [FinishTool.create()],
  });
}

describe('createAgentServerApp', () => {
  test('starts a conversation, accepts events, and searches them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ agentFactory, config: { conversationsPath: root } });
    try {
      const start = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: {
          initial_message: { role: 'user', content: [textContent('hello')], run: false },
        },
      });
      expect(start.statusCode).toBe(201);
      const info = start.json<{ id: string; execution_status: string }>();
      expect(info.execution_status).toBe('idle');

      const send = await app.inject({
        method: 'POST',
        url: `/api/conversations/${info.id}/events`,
        payload: { role: 'user', content: [textContent('second')], run: false },
      });
      expect(send.statusCode).toBe(200);

      const count = await app.inject({ method: 'GET', url: `/api/conversations/${info.id}/events/count?kind=MessageEvent&body=sec` });
      expect(count.json()).toBe(1);

      const search = await app.inject({ method: 'GET', url: `/api/conversations/${info.id}/events/search?sort_order=TIMESTAMP` });
      expect(search.json<{ items: unknown[] }>().items).toHaveLength(2);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('restores persisted conversations and events after restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    try {
      const first = await createAgentServerApp({ config: { conversationsPath: root } });
      const start = await first.app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: {
          id: '11111111-1111-4111-8111-111111111111',
          initial_message: { role: 'user', content: [textContent('persist me')], run: false },
          title: 'Persistent test',
          tags: { suite: 'persistence' },
        },
      });
      expect(start.statusCode).toBe(201);
      await first.app.inject({ method: 'POST', url: '/api/conversations/11111111-1111-4111-8111-111111111111/events', payload: { role: 'user', content: [textContent('after restart')], run: false } });
      await first.app.close();

      const second = await createAgentServerApp({ config: { conversationsPath: root } });
      const restored = await second.app.inject({ method: 'GET', url: '/api/conversations/11111111-1111-4111-8111-111111111111' });
      expect(restored.statusCode).toBe(200);
      expect(restored.json<{ title: string | null; tags: Record<string, string> }>().title).toBe('Persistent test');

      const events = await second.app.inject({ method: 'GET', url: '/api/conversations/11111111-1111-4111-8111-111111111111/events/search?sort_order=TIMESTAMP' });
      const page = events.json<{ items: Array<{ readonly kind: string }> }>();
      expect(page.items).toHaveLength(2);
      expect(await second.conversationService.countConversations()).toBe(1);
      await second.app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });


  test('runs a conversation through the injected SDK agent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ agentFactory, config: { conversationsPath: root } });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;
      await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('finish please')], run: false } });

      const run = await app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
      expect(run.statusCode).toBe(200);

      const info = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
      expect(info.json<{ execution_status: string }>().execution_status).toBe('finished');

      const final = await app.inject({ method: 'GET', url: `/api/conversations/${id}/agent_final_response` });
      expect(final.json<{ response: string }>().response).toBe('done');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('enforces X-Session-API-Key when configured', async () => {
    const { app } = await createAgentServerApp({ config: { sessionApiKey: 'secret' } });
    const denied = await app.inject({ method: 'GET', url: '/api/conversations/count' });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({ method: 'GET', url: '/api/conversations/count', headers: { 'x-session-api-key': 'secret' } });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  test('generates OpenAPI paths for upstream conversation/event contract', () => {
    const schema = generateOpenApiSchema();
    expect(schema.openapi).toBe('3.1.0');
    expect(schema.paths['/api/conversations/{conversation_id}/run']?.post).toBeDefined();
    expect(schema.paths['/api/conversations/{conversation_id}/events/search']?.get).toBeDefined();
    expect(schema.paths['/api/bash/execute_bash_command']?.post).toBeDefined();
    expect(schema.paths['/api/git/changes']?.get).toBeDefined();
    expect(schema.paths['/api/file/home']?.get).toBeDefined();
    const confirmationPolicy = schema.paths['/api/conversations/{conversation_id}/confirmation_policy']?.post as { readonly responses?: unknown } | undefined;
    expect(confirmationPolicy?.responses).toHaveProperty('410');
    expect(schema.paths['/api/conversations/{conversation_id}/turns']).toBeUndefined();
  });
});
