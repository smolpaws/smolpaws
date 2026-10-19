import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemorySecretStore, defaultAgentSettings } from '@smolpaws/openhands-agent';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import { createAgentServerApp } from '../app.js';
import type { SettingsResponse } from '../models.js';

const roots: string[] = [];
const apps: FastifyInstance[] = [];
const mcpConfig = { github: { transport: 'http', url: 'https://github.example/mcp' } };

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Adapted from upstream f47d9b926 test_agent_profiles_router.py. ACP execution
// remains unsupported, but stored ACP settings must not outlive the active profile.
describe('agent profile deletion settings cleanup', () => {
  test.each(['acp', 'openhands'] as const)('clears stale ACP settings after deleting an active %s profile and persists the reset', async (kind) => {
    const { app, root } = await fixture();
    await createAndActivateProfile(app, kind);
    await setStaleAcpSettings(app);

    expect((await app.inject({ method: 'DELETE', url: '/api/agent-profiles/active-agent' })).statusCode).toBe(200);
    const after = await settings(app);
    expect(after.active_agent_profile_id).toBe(await defaultAgentProfileId(app));
    expect(after.active_profile_id).toBe('selected-llm');
    expect(after.agent_settings).toEqual({ ...defaultAgentSettings('selected-llm'), mcp_config: mcpConfig });
    expect(after.agent_settings).not.toHaveProperty('acp_server');
    expect(after.agent_settings).not.toHaveProperty('acp_model');
    expect((await app.inject({ method: 'GET', url: '/api/agent-profiles/active-agent' })).statusCode).toBe(404);

    await app.close();
    const restored = await openApp(root);
    const reloaded = await settings(restored);
    expect(reloaded.agent_settings).toEqual(after.agent_settings);
    expect(reloaded.active_profile_id).toBe(after.active_profile_id);
    expect(reloaded.active_agent_profile_id).toBe(after.active_agent_profile_id);
    expect((await restored.inject({ method: 'GET', url: '/api/agent-profiles/active-agent' })).statusCode).toBe(404);
  });

  test.each(['acp', 'openhands'] as const)('preserves healthy OpenHands settings when deleting an active %s profile', async (kind) => {
    const { app } = await fixture();
    await createAndActivateProfile(app, kind);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_settings: {
      ...defaultAgentSettings('selected-llm'), enable_sub_agents: false, tool_concurrency_limit: 3,
      condenser: { condenser_kind: 'no_op', enabled: false }, mcp_config: mcpConfig,
    } } })).statusCode).toBe(200);
    const before = await settings(app);

    expect((await app.inject({ method: 'DELETE', url: '/api/agent-profiles/active-agent' })).statusCode).toBe(200);
    const after = await settings(app);
    expect(after).toEqual({ ...before, active_agent_profile_id: await defaultAgentProfileId(app) });
  });

  test.each(['inactive-agent', 'missing-agent'])('preserves settings and the active pointer when deleting %s', async (name) => {
    const { app } = await fixture();
    await createAndActivateProfile(app, 'acp');
    expect((await app.inject({ method: 'POST', url: '/api/agent-profiles/inactive-agent',
      payload: { agent_kind: 'acp', acp_server: 'codex' } })).statusCode).toBe(201);
    await setStaleAcpSettings(app);
    const before = await settings(app);

    expect((await app.inject({ method: 'DELETE', url: `/api/agent-profiles/${name}` })).statusCode).toBe(200);
    expect(await settings(app)).toEqual(before);
    expect((await app.inject({ method: 'GET', url: '/api/agent-profiles/active-agent' })).statusCode).toBe(200);
  });

  test('uses the existing default reference when no LLM profile is active without activating one', async () => {
    const { app } = await fixture();
    await createAndActivateProfile(app, 'acp');
    await setStaleAcpSettings(app);
    expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { active_profile_id: null } })).statusCode).toBe(200);

    expect((await app.inject({ method: 'DELETE', url: '/api/agent-profiles/active-agent' })).statusCode).toBe(200);
    const after = await settings(app);
    expect(after.active_profile_id).toBeNull();
    expect(after.active_agent_profile_id).toBe(await defaultAgentProfileId(app));
    expect(after.agent_settings).toEqual({ ...defaultAgentSettings('default'), mcp_config: mcpConfig });
  });
});

async function fixture(): Promise<{ app: FastifyInstance; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openhands-agent-profile-deletion-'));
  roots.push(root);
  const app = await openApp(root);
  expect((await app.inject({ method: 'POST', url: '/api/profiles', payload: {
    profileId: 'selected-llm', providerId: 'openai', model: 'synthetic-model',
  } })).statusCode).toBe(201);
  expect((await app.inject({ method: 'POST', url: '/api/profiles/selected-llm/activate' })).statusCode).toBe(200);
  return { app, root };
}

async function openApp(root: string): Promise<FastifyInstance> {
  const { app } = await createAgentServerApp({
    secretStore: new InMemorySecretStore(),
    config: { conversationsPath: path.join(root, 'conversations'), statePath: path.join(root, 'state'),
      workspaceRoot: path.join(root, 'workspace'), bashEventsPath: path.join(root, 'bash-events') },
  });
  apps.push(app);
  return app;
}

async function createAndActivateProfile(app: FastifyInstance, kind: 'acp' | 'openhands'): Promise<void> {
  const response = await app.inject({ method: 'POST', url: '/api/agent-profiles/active-agent',
    payload: kind === 'acp' ? { agent_kind: 'acp', acp_server: 'codex', acp_model: 'synthetic-acp-model' }
      : { agent_kind: 'openhands', llm_profile_ref: 'selected-llm' } });
  expect(response.statusCode).toBe(201);
  const { id } = response.json<{ id: string }>();
  expect((await app.inject({ method: 'POST', url: `/api/agent-profiles/${id}/activate` })).statusCode).toBe(200);
}

async function setStaleAcpSettings(app: FastifyInstance): Promise<void> {
  expect((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_settings: {
    agent_kind: 'acp', acp_server: 'codex', acp_model: 'synthetic-acp-model', mcp_config: mcpConfig,
  } } })).statusCode).toBe(200);
}

async function settings(app: FastifyInstance): Promise<SettingsResponse> {
  const response = await app.inject({ method: 'GET', url: '/api/settings' });
  expect(response.statusCode).toBe(200);
  return response.json<SettingsResponse>();
}

async function defaultAgentProfileId(app: FastifyInstance): Promise<string> {
  const response = await app.inject('/api/agent-profiles/default');
  expect(response.statusCode).toBe(200);
  const profile = response.json<{ id: string; name: string }>();
  expect(profile.name).toBe('default');
  expect(profile.id).toEqual(expect.any(String));
  return profile.id;
}
