import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, InMemorySecretStore, TestLLM, condensationSchema } from '@smolpaws/openhands-agent';
import { afterEach, expect, test } from 'vitest';

import { createAgentServerApp, type AgentServerApp } from '../app.js';

const oracle = JSON.parse(readFileSync(new URL('./fixtures/python-condensation-event.json', import.meta.url), 'utf8'));
const roots: string[] = [];
const servers: AgentServerApp[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) await server.app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'condensation-wire-'));
  roots.push(root);
  const server = await createAgentServerApp({
    secretStore: new InMemorySecretStore(),
    agentFactory: () => new Agent({ llm: TestLLM.fromMessages([]), tools: [] }),
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
      bashEventsPath: path.join(root, 'bash'), workspaceRoot: root },
  });
  servers.push(server);
  const response = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: {} });
  expect(response.statusCode).toBe(201);
  const id = response.json<{ id: string }>().id;
  const service = (await server.conversationService.getEventService(id))!;
  const event = condensationSchema.parse(oracle.event);
  await service.state.appendEventAsync(event);
  return { server, id, event };
}

test('wire fixture comes from the canonical pinned Python model', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../vendor/openhands-agent/transpile/upstream.json', import.meta.url), 'utf8'));
  expect(oracle.upstream_commit).toBe(manifest.commit);
});

for (const route of ['single', 'batch', 'search'] as const) {
  test(`${route} event REST response preserves Python condensation ID arrays`, async () => {
    const { server, id, event } = await fixture();
    const base = `/api/conversations/${id}/events`;
    const url = route === 'single' ? `${base}/${event.id}` : route === 'batch' ? `${base}?event_ids=${event.id}` : `${base}/search`;
    const response = await server.app.inject(url);
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    const actual = route === 'single' ? payload : route === 'batch' ? payload[0] : payload.items[0];
    expect(actual).toEqual(oracle.event);
    expect(event.forgotten_event_ids).toBeInstanceOf(Set);
    expect([...event.forgotten_event_ids]).toEqual(oracle.event.forgotten_event_ids);
  });
}

for (const family of ['events', 'session'] as const) {
  test(`${family} socket replays the Python condensation wire shape`, async () => {
    const { server, id, event } = await fixture();
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server');
    const query = family === 'events' ? 'resend_mode=all' : 'after_seq=-1';
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/sockets/${family}/${id}?${query}`);
    sockets.push(socket);
    let replay: unknown;
    socket.addEventListener('message', message => {
      const payload = JSON.parse(String(message.data));
      const candidate = family === 'events' ? payload : payload.event;
      if (candidate?.id === event.id) replay = candidate;
    });
    await expect.poll(() => replay).toEqual(oracle.event);
  });
}
