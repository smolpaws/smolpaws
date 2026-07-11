import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { Agent, EventLog, FinishTool, LocalFileStore, TestLLM, ToolDefinition, textContent } from '@smolpaws/openhands-agent';

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

function delayedFinishAgentFactory() {
  const delayTool = new ToolDefinition({
    name: 'delay',
    description: 'Wait for a short period.',
    inputSchema: z.object({ ms: z.number().int().min(1).max(500) }).strict(),
    executor: async ({ ms }) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { message: 'delayed' };
    },
  });
  return new Agent({
    llm: TestLLM.fromMessages([
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'delay-call-1', name: 'delay', arguments: JSON.stringify({ ms: 80 }), origin: 'completion' }],
      },
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'finish-call-1', name: 'finish', arguments: JSON.stringify({ message: 'first done' }), origin: 'completion' }],
      },
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'finish-call-2', name: 'finish', arguments: JSON.stringify({ message: 'rerun done' }), origin: 'completion' }],
      },
    ]),
    tools: [delayTool, FinishTool.create()],
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

      const sdkLog = new EventLog(new LocalFileStore(root), '11111111-1111-4111-8111-111111111111/events');
      expect(sdkLog.length).toBe(2);
      const eventFiles = await readdir(path.join(root, '11111111-1111-4111-8111-111111111111', 'events'));
      expect(eventFiles.filter((file) => file.startsWith('event-') && file.endsWith('.json'))).toHaveLength(2);
      expect(eventFiles).not.toContain('events.jsonl');
      const conversationFiles = await readdir(path.join(root, '11111111-1111-4111-8111-111111111111'));
      expect(conversationFiles).toContain('meta.json');
      expect(conversationFiles).not.toContain('events.jsonl');

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


  test('accepts a run=true message while a conversation is already running', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ agentFactory: delayedFinishAgentFactory, config: { conversationsPath: path.join(root, 'conversations'), workspaceRoot: root } });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;
      await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('first')], run: false } });

      const run = app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
      await sleep(20);
      const send = await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('second while running')], run: true } });
      expect(send.statusCode).toBe(200);
      expect(await run).toHaveProperty('statusCode', 200);

      const events = await app.inject({ method: 'GET', url: `/api/conversations/${id}/events/search?kind=MessageEvent&sort_order=TIMESTAMP` });
      expect(events.json<{ items: unknown[] }>().items).toHaveLength(2);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('constrains file upload and download to workspace roots and escapes filenames', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-outside-'));
    const conversationsPath = path.join(root, 'conversations');
    const specialFile = path.join(root, 'evil"name.txt');
    const uploadTarget = path.join(root, 'uploaded.txt');
    const outsideFile = path.join(outside, 'secret.txt');
    const { app } = await createAgentServerApp({ config: { conversationsPath, workspaceRoot: root } });
    try {
      await mkdir(conversationsPath, { recursive: true });
      await writeFile(specialFile, 'safe content', 'utf8');
      await writeFile(outsideFile, 'secret', 'utf8');

      const allowed = await app.inject({ method: 'GET', url: `/api/file/download?path=${encodeURIComponent(specialFile)}` });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers['content-disposition']).toContain('filename="evil_name.txt"');
      expect(allowed.headers['content-disposition']).toContain("filename*=UTF-8''evil%22name.txt");
      expect(allowed.body).toBe('safe content');

      const deniedDownload = await app.inject({ method: 'GET', url: `/api/file/download?path=${encodeURIComponent(outsideFile)}` });
      expect(deniedDownload.statusCode).toBe(403);

      const deniedUpload = await app.inject({ method: 'POST', url: `/api/file/upload?path=${encodeURIComponent(path.join(outside, 'uploaded.txt'))}`, headers: { 'content-type': 'text/plain' }, payload: 'nope' });
      expect(deniedUpload.statusCode).toBe(403);

      const upload = await app.inject({ method: 'POST', url: `/api/file/upload?path=${encodeURIComponent(uploadTarget)}`, headers: { 'content-type': 'text/plain' }, payload: 'uploaded' });
      expect(upload.statusCode).toBe(200);
      expect(await readFile(uploadTarget, 'utf8')).toBe('uploaded');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('preserves OPENHANDS_BASH_EVENTS_PATH when conversationsPath is overridden', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const previous = process.env.OPENHANDS_BASH_EVENTS_PATH;
    const customBashEventsPath = path.join(root, 'custom-bash-events');
    const conversationsPath = path.join(root, 'conversations');
    process.env.OPENHANDS_BASH_EVENTS_PATH = customBashEventsPath;
    const { app } = await createAgentServerApp({ config: { conversationsPath } });
    try {
      const output = await app.inject({ method: 'POST', url: '/api/bash/execute_bash_command', payload: { command: 'printf ok', timeout: 2 } });
      expect(output.statusCode).toBe(200);
      expect((await readdir(customBashEventsPath)).some((file) => file.endsWith('.json'))).toBe(true);
      const derivedBashEventsPath = path.join(conversationsPath, 'bash_events');
      await expect(readdir(derivedBashEventsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.OPENHANDS_BASH_EVENTS_PATH;
      else process.env.OPENHANDS_BASH_EVENTS_PATH = previous;
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
