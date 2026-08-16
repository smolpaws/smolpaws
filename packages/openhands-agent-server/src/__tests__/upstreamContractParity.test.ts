import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  FinishTool,
  Message,
  TestLLM,
} from '@smolpaws/openhands-agent';

import { createServerApp } from '../app.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(async (target) => rm(target, { recursive: true, force: true })));
});

describe('pinned upstream server behavior', () => {
  it('accepts canonical GET batch bodies while retaining query aliases', async () => {
    const { app } = await createTestApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: {
          agent: {
            agent_context: {
              skills: [{ name: 'private-skill' }],
            },
          },
          workspace: { working_dir: 'workspace/project' },
        },
      });
      expect(started.statusCode).toBe(201);
      const conversation = started.json<{ id: string; agent?: unknown }>();

      const conversationBatch = await app.inject({
        method: 'GET',
        url: '/api/conversations',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify([conversation.id]),
      });
      expect(conversationBatch.statusCode).toBe(200);
      expect(conversationBatch.json<Array<{ id: string } | null>>()).toEqual([
        expect.objectContaining({ id: conversation.id }),
      ]);

      const sent = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/events`,
        payload: { role: 'user', content: 'hello', run: false },
      });
      expect(sent.statusCode).toBe(200);
      const eventId = sent.json<{ event_id: string }>().event_id;

      const eventBatch = await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversation.id}/events`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify([eventId]),
      });
      expect(eventBatch.statusCode).toBe(200);
      expect(eventBatch.json<Array<{ id: string } | null>>()).toEqual([
        expect.objectContaining({ id: eventId }),
      ]);

      const bash = await app.inject({
        method: 'POST',
        url: '/api/bash/execute_bash_command',
        payload: { command: 'printf batch-body', timeout: 5 },
      });
      expect(bash.statusCode).toBe(200);
      const bashEventId = bash.json<{ id: string }>().id;

      const bashBatch = await app.inject({
        method: 'GET',
        url: '/api/bash/bash_events',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify([bashEventId]),
      });
      expect(bashBatch.statusCode).toBe(200);
      expect(bashBatch.json<Array<{ id: string } | null>>()).toEqual([
        expect.objectContaining({ id: bashEventId }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('omits serialized agent skills by default and includes them on request', async () => {
    const { app } = await createTestApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: {
          agent: {
            agent_context: {
              skills: [{ name: 'private-skill' }],
            },
          },
          workspace: { working_dir: 'workspace/project' },
        },
      });
      expect(started.statusCode).toBe(201);
      expect(serializedSkills(started.json())).toEqual([]);
      const id = started.json<{ id: string }>().id;

      const hidden = await app.inject({
        method: 'GET',
        url: `/api/conversations/${id}`,
      });
      expect(hidden.statusCode).toBe(200);
      expect(serializedSkills(hidden.json())).toEqual([]);

      const included = await app.inject({
        method: 'GET',
        url: `/api/conversations/${id}?include_skills=true`,
      });
      expect(included.statusCode).toBe(200);
      expect(serializedSkills(included.json())).toEqual([{ name: 'private-skill' }]);
    } finally {
      await app.close();
    }
  });

  it('filters bash events by the pinned timestamp query names', async () => {
    const { app } = await createTestApp();
    try {
      const before = new Date(Date.now() - 1_000).toISOString();
      const bash = await app.inject({
        method: 'POST',
        url: '/api/bash/execute_bash_command',
        payload: { command: 'printf timestamp-filter', timeout: 5 },
      });
      expect(bash.statusCode).toBe(200);
      const after = new Date(Date.now() + 1_000).toISOString();

      const inside = await app.inject({
        method: 'GET',
        url: `/api/bash/bash_events/search?timestamp__gte=${encodeURIComponent(before)}&timestamp__lt=${encodeURIComponent(after)}`,
      });
      expect(inside.statusCode).toBe(200);
      expect(inside.json<{ items: unknown[] }>().items.length).toBeGreaterThan(0);

      const outside = await app.inject({
        method: 'GET',
        url: `/api/bash/bash_events/search?timestamp__gte=${encodeURIComponent(after)}`,
      });
      expect(outside.statusCode).toBe(200);
      expect(outside.json<{ items: unknown[] }>().items).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('accepts an omitted fork request body', async () => {
    const { app } = await createTestApp();
    try {
      const started = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { workspace: { working_dir: 'workspace/project' } },
      });
      const id = started.json<{ id: string }>().id;

      const forked = await app.inject({
        method: 'POST',
        url: `/api/conversations/${id}/fork`,
      });
      expect(forked.statusCode).toBe(201);
      expect(forked.json<{ id: string }>().id).not.toBe(id);
    } finally {
      await app.close();
    }
  });
});

async function createTestApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-server-parity-'));
  cleanupPaths.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const bashEventsDir = path.join(root, 'bash-events');

  return createServerApp({
    workspaceRoot,
    stateDir,
    bashEventsDir,
    agentFactory: () => new Agent({
      llm: new TestLLM([
        Message.fromLit({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
      ]),
      tools: [FinishTool.create()],
    }),
  });
}

function serializedSkills(value: unknown): unknown[] | null {
  if (!isRecord(value) || !isRecord(value.agent) || !isRecord(value.agent.agent_context)) {
    return null;
  }
  const skills = value.agent.agent_context.skills;
  return Array.isArray(skills) ? skills : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
