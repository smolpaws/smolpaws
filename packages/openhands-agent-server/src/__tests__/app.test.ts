import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { Agent, EventLog, FinishTool, InMemorySecretStore, LocalFileStore, RemoteConversation, RemoteWorkspace, TestLLM, ToolDefinition, textContent } from '@smolpaws/openhands-agent';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

import { createAgentServerApp } from '../app.js';
import { leaseFileName } from '../conversationLease.js';
import { conversationSecretRef } from '../conversationSecrets.js';
import { generateOpenApiSchema } from '../openapi.js';

const execFileAsync = promisify(execFile);


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

async function waitFor(assertion: () => Promise<void> | void, timeoutMs = 1000): Promise<void> {
  const started = performance.now();
  let lastError: unknown;
  while (performance.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(20);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error('waitFor timed out');
}

async function waitForWebSocketOpen(socket: WebSocket, timeoutMs = 1000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await waitForWebSocketEvent(socket, 'open', timeoutMs);
}

async function waitForWebSocketMessage(socket: WebSocket, timeoutMs = 1000): Promise<string> {
  const event = await waitForWebSocketEvent<MessageEvent>(socket, 'message', timeoutMs);
  return typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8');
}

function waitForWebSocketEvent<T extends Event>(socket: WebSocket, eventName: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for WebSocket ${eventName}`));
    }, timeoutMs);
    const onEvent = (event: Event) => {
      cleanup();
      resolve(event as T);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`WebSocket error before ${eventName}`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket closed before ${eventName}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener(eventName, onEvent);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener(eventName, onEvent);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
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

      await waitFor(async () => {
        const info = await app.inject({ method: 'GET', url: `/api/conversations/${id}` });
        expect(info.json<{ execution_status: string }>().execution_status).toBe('finished');
      });

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

  test('reports Node runtime version without nondeterministic OpenAPI defaults', async () => {
    const { app } = await createAgentServerApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/server_info' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ python_version: 'not-applicable', node_version: process.version });
    } finally {
      await app.close();
    }
  });

  test('generates OpenAPI paths for upstream conversation/event contract', () => {
    const schema = generateOpenApiSchema();
    expect(schema.openapi).toBe('3.1.0');
    const serializedSchema = JSON.stringify(schema);
    expect(serializedSchema).not.toContain(process.version);
    expect(serializedSchema).toContain('node_version');
    expect(schema.paths['/api/conversations/{conversation_id}/run']?.post).toBeDefined();
    expect(schema.paths['/api/conversations/{conversation_id}/events/search']?.get).toBeDefined();
    expect(schema.paths['/api/bash/execute_bash_command']?.post).toBeDefined();
    expect(schema.paths['/api/git/changes']?.get).toBeDefined();
    expect(schema.paths['/api/file/home']?.get).toBeDefined();
    expect(schema.paths['/api/settings']?.get).toBeDefined();
    expect(schema.paths['/api/profiles']?.post).toBeDefined();
    expect(schema.paths['/api/agent-profiles']?.post).toBeDefined();
    expect(schema.paths['/api/skills']?.post).toBeDefined();
    const eventSearch = schema.paths['/api/conversations/{conversation_id}/events/search']?.get as { readonly parameters?: Array<{ readonly name: string; readonly in: string }> } | undefined;
    expect(eventSearch?.parameters).toContainEqual(expect.objectContaining({ name: 'limit', in: 'query' }));
    expect(eventSearch?.parameters).toContainEqual(expect.objectContaining({ name: 'sort_order', in: 'query' }));
    const bashBatch = schema.paths['/api/bash/bash_events']?.get as { readonly parameters?: Array<{ readonly name: string; readonly in: string }> } | undefined;
    expect(bashBatch?.parameters).toContainEqual(expect.objectContaining({ name: 'event_ids', in: 'query' }));
    const confirmationPolicy = schema.paths['/api/conversations/{conversation_id}/confirmation_policy']?.post as { readonly responses?: unknown } | undefined;
    expect(confirmationPolicy?.responses).toHaveProperty('410');
    expect(schema.paths['/api/conversations/{conversation_id}/turns']).toBeUndefined();
  });

  test('POST /run schedules work and returns before the agent finishes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ agentFactory: delayedFinishAgentFactory, config: { conversationsPath: root } });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;
      await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('finish slowly')], run: false } });
      const started = performance.now();
      const run = await app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
      expect(run.statusCode).toBe(200);
      expect(performance.now() - started).toBeLessThan(70);
      await waitFor(async () => {
        const final = await app.inject({ method: 'GET', url: `/api/conversations/${id}/agent_final_response` });
        expect(final.json<{ response: string }>().response).toBe('first done');
      });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('accepts a message while a run is actively writing events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ agentFactory: delayedFinishAgentFactory, config: { conversationsPath: root } });
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;
      await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('first active message')], run: false } });
      const run = await app.inject({ method: 'POST', url: `/api/conversations/${id}/run` });
      expect(run.statusCode).toBe(200);
      await sleep(20);
      const queued = await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('queued active message')], run: true } });
      expect(queued.statusCode).toBe(200);
      await waitFor(async () => {
        const final = await app.inject({ method: 'GET', url: `/api/conversations/${id}/agent_final_response` });
        expect(final.json<{ response: string }>().response).toBe('first done');
      });
      const events = await app.inject({ method: 'GET', url: `/api/conversations/${id}/events/search?kind=MessageEvent&source=user` });
      const body = JSON.stringify(events.json());
      expect(body).toContain('first active message');
      expect(body).toContain('queued active message');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not retry an event append after lock cleanup fails post-write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ config: { conversationsPath: root } });
    const originalLockAsync = LocalFileStore.prototype.lockAsync;
    let eventLogCallbacks = 0;
    LocalFileStore.prototype.lockAsync = async function lockAsyncWithCleanupFailure<T>(
      filePath: string,
      callback: () => T | Promise<T>,
      options?: Parameters<typeof originalLockAsync>[2],
    ): Promise<T> {
      if (filePath.endsWith('.eventlog.lock')) {
        eventLogCallbacks += 1;
        await callback();
        throw new Error(`cleanup failed for ${filePath}`);
      }
      return originalLockAsync.call(this, filePath, callback, options);
    };

    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
      const id = start.json<{ id: string }>().id;
      const response = await app.inject({ method: 'POST', url: `/api/conversations/${id}/events`, payload: { role: 'user', content: [textContent('cleanup failure message')], run: false } });
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain('cleanup failed for');
      expect(response.body).not.toContain('already exists');
      expect(eventLogCallbacks).toBe(1);

      const events = await app.inject({ method: 'GET', url: `/api/conversations/${id}/events/search?kind=MessageEvent&source=user` });
      expect(events.statusCode).toBe(200);
      expect(JSON.stringify(events.json())).toContain('cleanup failure message');
    } finally {
      LocalFileStore.prototype.lockAsync = originalLockAsync;
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });



  test('accepts WebSocket session API key as the first message', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ config: { conversationsPath: path.join(root, 'conversations'), sessionApiKey: 'secret' } });
    let socket: WebSocket | null = null;
    try {
      const start = await app.inject({ method: 'POST', url: '/api/conversations', headers: { 'x-session-api-key': 'secret' }, payload: {} });
      const id = start.json<{ id: string }>().id;
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/sockets/events/${id}`);
      await waitForWebSocketOpen(socket);
      socket.send(JSON.stringify({ type: 'auth', session_api_key: 'secret' }));
      const payload = JSON.parse(await waitForWebSocketMessage(socket)) as { key?: string };
      expect(payload.key).toBe('full_state');
    } finally {
      socket?.close();
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('canonicalizes git paths reached through a filesystem alias', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const repo = path.join(root, 'repo');
    const alias = path.join(root, 'repo-alias');
    const filePath = path.join(repo, 'tracked.txt');
    await mkdir(repo);
    await execFileAsync('git', ['-C', repo, 'init', '-q']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
    await writeFile(filePath, 'base\n', 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', 'tracked.txt']);
    await execFileAsync('git', ['-C', repo, 'commit', '-q', '-m', 'init']);
    await symlink(repo, alias);
    await writeFile(filePath, 'changed\n', 'utf8');
    const { app } = await createAgentServerApp({ config: { conversationsPath: path.join(root, 'conversations'), workspaceRoot: repo } });
    try {
      const changes = await app.inject({ method: 'GET', url: `/api/git/changes?path=${encodeURIComponent(path.join(alias, 'tracked.txt'))}` });
      expect(changes.statusCode).toBe(200);
      expect(changes.json()).toEqual([{ status: 'UPDATED', path: 'tracked.txt' }]);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('serves bash batch events on documented and upstream trailing-slash paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ config: { conversationsPath: path.join(root, 'conversations'), bashEventsPath: path.join(root, 'bash-events') } });
    try {
      for (const url of ['/api/bash/bash_events?event_ids=missing-event-id', '/api/bash/bash_events/?event_ids=missing-event-id']) {
        const batch = await app.inject({ method: 'GET', url });
        expect(batch.statusCode).toBe(200);
        expect(batch.json()).toEqual([null]);
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });


  test('serves settings, profiles, agent-profiles, and secret metadata without plaintext persistence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const statePath = path.join(root, 'state');
    const { app } = await createAgentServerApp({ config: { conversationsPath: path.join(root, 'conversations'), statePath }, secretStore: new InMemorySecretStore() });
    try {
      const profile = await app.inject({ method: 'POST', url: '/api/profiles', payload: { profileId: 'audit', providerId: 'openai', model: 'gpt-5-nano', baseUrl: null, openAiApiMode: 'responses' } });
      expect(profile.statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/profiles/audit/activate' })).statusCode).toBe(200);
      const settings = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { llm_api_key: 'fake-secret-value' } });
      expect(settings.statusCode).toBe(200);
      expect(settings.json<{ llm_api_key_set: boolean }>().llm_api_key_set).toBe(true);

      const secret = await app.inject({ method: 'PUT', url: '/api/settings/secrets', payload: { name: 'TOKEN', value: 'plaintext-token' } });
      expect(secret.statusCode).toBe(200);
      expect(secret.body).not.toContain('plaintext-token');
      const redacted = await app.inject({ method: 'GET', url: '/api/settings/secrets/TOKEN' });
      expect(redacted.json<{ value: string }>().value).toBe('**********');

      const agentProfile = await app.inject({ method: 'POST', url: '/api/agent-profiles', payload: { name: 'cat', llm_profile_ref: 'audit' } });
      expect(agentProfile.statusCode).toBe(201);
      const agentProfileId = agentProfile.json<{ id: string }>().id;
      expect((await app.inject({ method: 'POST', url: `/api/agent-profiles/${agentProfileId}/activate` })).statusCode).toBe(200);
      const materialized = await app.inject({ method: 'POST', url: '/api/agent-profiles/cat/materialize' });
      expect(materialized.statusCode).toBe(200);
      expect(JSON.stringify(materialized.json())).not.toMatch(/sk-secret-value|plaintext-token/u);
      expect(await readFile(path.join(statePath, 'state.json'), 'utf8')).not.toMatch(/sk-secret-value|plaintext-token/u);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('stores conversation secrets only in SecretStore and never in metadata or events', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const secretStore = new InMemorySecretStore();
    const conversationsPath = path.join(root, 'conversations');
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const { app } = await createAgentServerApp({ config: { conversationsPath }, secretStore });
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { id: conversationId, secrets: { START_TOKEN: 'start-secret-value' } },
      });
      expect(started.statusCode).toBe(201);
      expect(await secretStore.get(conversationSecretRef(conversationId, 'START_TOKEN'))).toBe('start-secret-value');

      const updated = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/secrets`,
        payload: { secrets: { RUNTIME_TOKEN: { value: 'runtime-secret-value' }, START_TOKEN: null } },
      });
      expect(updated.statusCode).toBe(200);
      expect(await secretStore.get(conversationSecretRef(conversationId, 'START_TOKEN'))).toBeNull();
      expect(await secretStore.get(conversationSecretRef(conversationId, 'RUNTIME_TOKEN'))).toBe('runtime-secret-value');

      const info = (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })).json<{ secret_registry: Record<string, unknown> }>();
      expect(info.secret_registry).toEqual({ RUNTIME_TOKEN: { source: 'keychain', ref: conversationSecretRef(conversationId, 'RUNTIME_TOKEN') } });

      const meta = await readFile(path.join(conversationsPath, conversationId, 'meta.json'), 'utf8');
      expect(meta).toContain('RUNTIME_TOKEN');
      expect(meta).not.toMatch(/start-secret-value|runtime-secret-value/u);
      const eventsDir = path.join(conversationsPath, conversationId, 'events');

      const forkId = '33333333-3333-4333-8333-333333333333';
      const forked = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/fork`, payload: { id: forkId } });
      expect(forked.statusCode).toBe(201);
      expect(await secretStore.get(conversationSecretRef(forkId, 'RUNTIME_TOKEN'))).toBe('runtime-secret-value');
      expect(await readFile(path.join(conversationsPath, forkId, 'meta.json'), 'utf8')).not.toContain('runtime-secret-value');

      const eventFiles = await readdir(eventsDir).catch(() => []);
      const events = await Promise.all(eventFiles.map((file) => readFile(path.join(eventsDir, file), 'utf8')));
      expect(events.join('\n')).not.toMatch(/start-secret-value|runtime-secret-value/u);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('prevents simultaneous ownership of the same persisted conversation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const conversationsPath = path.join(root, 'conversations');
    const conversationId = '22222222-2222-4222-8222-222222222222';
    const first = await createAgentServerApp({ config: { conversationsPath }, secretStore: new InMemorySecretStore() });
    try {
      const started = await first.app.inject({ method: 'POST', url: '/api/conversations', payload: { id: conversationId } });
      expect(started.statusCode).toBe(201);
      const lease = JSON.parse(await readFile(path.join(conversationsPath, conversationId, leaseFileName), 'utf8')) as Record<string, unknown>;
      expect(lease.owner_instance_id).toEqual(expect.any(String));
      expect(lease.generation).toBe(1);

      const second = await createAgentServerApp({ config: { conversationsPath }, secretStore: new InMemorySecretStore() });
      try {
        const duplicate = await second.app.inject({ method: 'POST', url: '/api/conversations', payload: { id: conversationId } });
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json<{ detail: string }>().detail).toContain('conversation lease is held');
      } finally {
        await second.app.close();
      }
    } finally {
      await first.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('loads project skills and manages local installed skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const projectSkill = path.join(root, 'project', '.openhands', 'skills', 'demo', 'SKILL.md');
    const localSkill = path.join(root, 'local-skill', 'SKILL.md');
    await mkdir(path.dirname(projectSkill), { recursive: true });
    await mkdir(path.dirname(localSkill), { recursive: true });
    await writeFile(projectSkill, '---\nname: demo\ndescription: Demo project skill\ntriggers:\n  - demo\n---\nUse demo skill.\n', 'utf8');
    await writeFile(localSkill, '---\nname: installed-demo\ndescription: Installed skill\n---\nInstalled content.\n', 'utf8');
    const { app } = await createAgentServerApp({ config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'), workspaceRoot: path.join(root, 'project') }, secretStore: new InMemorySecretStore() });
    try {
      const loaded = await app.inject({ method: 'POST', url: '/api/skills', payload: { load_user: false, load_project: true, project_dir: path.join(root, 'project') } });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.json<{ skills: Array<{ name: string }> }>().skills.some((skill) => skill.name === 'demo')).toBe(true);
      const installed = await app.inject({ method: 'POST', url: '/api/skills/install', payload: { source: path.dirname(localSkill) } });
      expect(installed.statusCode).toBe(201);
      const list = await app.inject({ method: 'GET', url: '/api/skills/installed' });
      expect(list.json<{ skills: Array<{ name: string; enabled: boolean }> }>().skills).toContainEqual(expect.objectContaining({ name: 'installed-demo', enabled: true }));
      const disabled = await app.inject({ method: 'PATCH', url: '/api/skills/installed/installed-demo', payload: { enabled: false } });
      expect(disabled.json()).toEqual({ name: 'installed-demo', enabled: false });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('supports SDK RemoteConversation and RemoteWorkspace against the live Fastify app', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-server-'));
    const { app } = await createAgentServerApp({ agentFactory: delayedFinishAgentFactory, config: { conversationsPath: path.join(root, 'conversations'), workspaceRoot: root, sessionApiKey: 'secret' }, secretStore: new InMemorySecretStore() });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
      const host = `http://127.0.0.1:${address.port}`;
      const start = await app.inject({ method: 'POST', url: '/api/conversations', headers: { 'x-session-api-key': 'secret' }, payload: {} });
      const conversation = new RemoteConversation({ host, conversationId: start.json<{ id: string }>().id, apiKey: 'secret' });
      await conversation.sendMessage('hello');
      const started = performance.now();
      await conversation.run({ blocking: false });
      expect(performance.now() - started).toBeLessThan(100);

      const workspace = new RemoteWorkspace({ host, apiKey: 'secret', workingDir: root });
      const command = await workspace.executeCommand('printf remote-ok', { timeoutSeconds: 3 });
      expect(command.stdout).toBe('remote-ok');
      await writeFile(path.join(root, 'upload-source.txt'), 'client file', 'utf8');
      const upload = await workspace.fileUpload(path.join(root, 'upload-source.txt'), 'uploaded-by-client.txt');
      expect(upload.success).toBe(true);
      const downloadPath = path.join(root, 'downloaded.txt');
      const download = await workspace.fileDownload('uploaded-by-client.txt', downloadPath);
      expect(download.success).toBe(true);
      expect(await readFile(downloadPath, 'utf8')).toBe('client file');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});
