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

describe('GET /api/settings/secrets agent_profile_id scoping', () => {
  it('scopes the secret list to a profile, keeps unscoped profiles unbound, and 404s on a missing profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-server-secret-scope-'));
    cleanupPaths.push(root);
    const { app } = await createAgentServerApp({
      secretStore: new InMemorySecretStore(),
      config: {
        conversationsPath: path.join(root, 'conversations'),
        workspaceRoot: path.join(root, 'workspace'),
        statePath: path.join(root, 'state'),
        bashEventsPath: path.join(root, 'bash-events'),
        sessionApiKey: null,
      },
    });
    try {
      await app.inject({ method: 'PUT', url: '/api/settings/secrets', payload: { name: 'FIRST', value: 'first-value' } });
      await app.inject({ method: 'PUT', url: '/api/settings/secrets', payload: { name: 'SECOND', value: 'second-value' } });

      const all = (await app.inject({ method: 'GET', url: '/api/settings/secrets' })).json<{ secrets: Array<{ name: string }> }>();
      expect(all.secrets.map((secret) => secret.name)).toEqual(['FIRST', 'SECOND']);

      const profile = await app.inject({
        method: 'POST',
        url: '/api/agent-profiles',
        payload: { name: 'scoped', llm_profile_ref: 'unused', secret_refs: ['FIRST'] },
      });
      expect(profile.statusCode).toBe(201);
      const profileId = profile.json<{ id: string }>().id;

      const scoped = (await app.inject({ method: 'GET', url: `/api/settings/secrets?agent_profile_id=${profileId}` })).json<{ secrets: Array<{ name: string }> }>();
      expect(scoped.secrets.map((secret) => secret.name)).toEqual(['FIRST']);

      const unbound = await app.inject({
        method: 'POST',
        url: '/api/agent-profiles',
        payload: { name: 'unbound', llm_profile_ref: 'unused' },
      });
      const unboundId = unbound.json<{ id: string }>().id;
      const unboundList = (await app.inject({ method: 'GET', url: `/api/settings/secrets?agent_profile_id=${unboundId}` })).json<{ secrets: Array<{ name: string }> }>();
      expect(unboundList.secrets.map((secret) => secret.name)).toEqual(['FIRST', 'SECOND']);

      const missing = await app.inject({ method: 'GET', url: '/api/settings/secrets?agent_profile_id=does-not-exist' });
      expect(missing.statusCode).toBe(404);
      expect(missing.json<{ detail: string }>().detail).toBe('Agent profile not found');
    } finally {
      await app.close();
    }
  });
});
