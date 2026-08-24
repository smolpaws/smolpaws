import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentServerApp } from '../app.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(async (target) => rm(target, { recursive: true, force: true })));
});

describe('MCP settings CRUD endpoints', () => {
  it('creates, patches, and deletes named MCP servers without clobbering siblings', async () => {
    const { app } = await createTestApp();
    try {
      const github = await app.inject({
        method: 'POST',
        url: '/api/settings/mcp/github',
        payload: {
          transport: 'http',
          url: 'https://github.example/mcp',
          auth: { strategy: 'bearer', value: 'github-secret' },
        },
      });
      expect(github.statusCode).toBe(201);
      expect(github.json<{ agent_settings: { mcp_config: Record<string, { auth: unknown }> } }>()
        .agent_settings.mcp_config.github.auth).toEqual({ strategy: 'bearer', value: 'github-secret' });

      const docs = await app.inject({
        method: 'POST',
        url: '/api/settings/mcp/docs',
        payload: { transport: 'http', url: 'https://docs.example/mcp' },
      });
      expect(docs.statusCode).toBe(201);

      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/settings/mcp/docs',
        payload: { description: 'Documentation' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json<{ agent_settings: { mcp_config: Record<string, { description?: string }> } }>()
        .agent_settings.mcp_config.docs.description).toBe('Documentation');

      const mcpConfig = (await app.inject({ method: 'GET', url: '/api/settings' }))
        .json<{ agent_settings: { mcp_config: Record<string, unknown> } }>()
        .agent_settings.mcp_config;
      expect(mcpConfig.github.auth).toEqual({ strategy: 'bearer', value: 'github-secret' });

      const deleted = await app.inject({ method: 'DELETE', url: '/api/settings/mcp/docs' });
      expect(deleted.statusCode).toBe(200);
      expect(Object.keys(deleted.json<{ agent_settings: { mcp_config: Record<string, unknown> } }>()
        .agent_settings.mcp_config)).toEqual(['github']);

      const replacedAuth = await app.inject({
        method: 'PATCH',
        url: '/api/settings/mcp/github',
        payload: { auth: { strategy: 'bearer', value: 'new-github-secret' } },
      });
      expect(replacedAuth.statusCode).toBe(200);
      expect(replacedAuth.json<{ agent_settings: { mcp_config: Record<string, { auth: unknown }> } }>()
        .agent_settings.mcp_config.github.auth).toEqual({ strategy: 'bearer', value: 'new-github-secret' });

      const clearedAuth = await app.inject({
        method: 'PATCH',
        url: '/api/settings/mcp/github',
        payload: { auth: null },
      });
      expect(clearedAuth.statusCode).toBe(200);
      expect(clearedAuth.json<{ agent_settings: { mcp_config: Record<string, Record<string, unknown>> } }>()
        .agent_settings.mcp_config.github).not.toHaveProperty('auth');
    } finally {
      await app.close();
    }
  });

  it('enforces create/patch/delete key preconditions', async () => {
    const { app } = await createTestApp();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/settings/mcp/github',
        payload: { transport: 'http', url: 'https://github.example/mcp' },
      });
      expect(created.statusCode).toBe(201);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/settings/mcp/github',
        payload: { transport: 'http', url: 'https://replacement.example/mcp' },
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json<{ detail: string }>().detail).toBe("MCP server 'github' already exists");

      const missingPatch = await app.inject({
        method: 'PATCH',
        url: '/api/settings/mcp/missing',
        payload: { description: 'Missing' },
      });
      expect(missingPatch.statusCode).toBe(404);

      const missingDelete = await app.inject({ method: 'DELETE', url: '/api/settings/mcp/missing' });
      expect(missingDelete.statusCode).toBe(404);

      const mcpConfig = (await app.inject({ method: 'GET', url: '/api/settings' }))
        .json<{ agent_settings: { mcp_config: Record<string, unknown> } }>()
        .agent_settings.mcp_config;
      expect(mcpConfig.github.url).toBe('https://github.example/mcp');
    } finally {
      await app.close();
    }
  });
});

async function createTestApp() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-server-mcp-crud-'));
  cleanupPaths.push(root);
  const workspaceRoot = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const bashEventsDir = path.join(root, 'bash-events');

  return createAgentServerApp({
    secretStore: new InMemorySecretStore(),
    config: {
      conversationsPath: path.join(root, 'conversations'),
      workspaceRoot,
      statePath: stateDir,
      bashEventsPath: bashEventsDir,
    },
  });
}
