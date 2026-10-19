import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySecretStore, llmProfileSchema, skillSchema } from '@smolpaws/openhands-agent';
import { expect, it, vi } from 'vitest';
import { createAgentServerApp } from '../app.js';
import { restoreResolvedLaunch } from '../launch.js';
import { SkillsCatalogService } from '../skillsService.js';

it('shares one injected offline catalog between skills HTTP, draft preview and captured profile launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'server04-skills-app-'));
  const loadPublic = vi.fn(async () => [skillSchema.parse({ name: 'public', content: 'public snapshot' })]);
  const loadUser = vi.fn(async () => [skillSchema.parse({ name: 'user', content: 'user snapshot' })]);
  const service = new SkillsCatalogService({ stateDir: join(root, 'state'), workspaceRoot: root, loadPublic, loadUser,
    loadProject: async () => [skillSchema.parse({ name: 'injected-project', content: 'offline project' })] });
  const complete = vi.fn(async () => { throw new Error('No provider calls allowed'); });
  const options = { config: { workspaceRoot: root, statePath: join(root, 'state'), conversationsPath: join(root, 'conversations'), bashEventsPath: join(root, 'bash') },
    secretStore: new InMemorySecretStore(), skillsCatalogService: service, llmClientFactory: async (profile: ReturnType<typeof llmProfileSchema.parse>) => ({ profile, complete }) };
  const server = await createAgentServerApp(options);
  try {
    // This first request is offline even before app wiring: it cannot start a public fetch or user-directory scan.
    const project = await server.app.inject({ method: 'POST', url: '/api/skills', payload: { load_public: false, load_user: false, load_project: true } });
    expect(project.statusCode).toBe(200); expect(project.json().skills.map((skill: { name: string }) => skill.name)).toEqual(['injected-project']);
    const loaded = await server.app.inject({ method: 'POST', url: '/api/skills', payload: { load_project: false } });
    expect(loaded.statusCode).toBe(200); expect(loaded.json().skills.map((skill: { name: string }) => skill.name)).toEqual(['public', 'user']);
    expect(loadPublic).toHaveBeenCalledOnce(); expect(loadUser).toHaveBeenCalledOnce();
    await server.serverStateService.saveProfile(llmProfileSchema.parse({ profileId: 'main', providerId: 'openai', model: 'fixture' }));
    const profile = { name: 'worker', llm_profile_ref: 'main', tools: [], condenser: { enabled: false }, public_skills: null };
    const preview = await server.app.inject({ method: 'POST', url: '/api/agent-profiles/unsaved/materialize', payload: { profile } });
    expect(preview.statusCode).toBe(200); expect(preview.json()).toMatchObject({ valid: true, resolved_skills: ['public', 'user'] });
    expect(loadPublic).toHaveBeenCalledTimes(2); expect(loadUser).toHaveBeenCalledTimes(2);
    const saved = await server.serverStateService.saveAgentProfile(profile);
    const created = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent_profile_id: saved.id } });
    expect(created.statusCode).toBe(201);
    const metadata = JSON.parse(await readFile(join(root, 'conversations', created.json().id, 'meta.json'), 'utf8'));
    expect(restoreResolvedLaunch(metadata.request)?.context?.skills?.map(skill => [skill.name, skill.content])).toEqual([['public', 'public snapshot'], ['user', 'user snapshot']]);
    expect(loadPublic).toHaveBeenCalledTimes(3); expect(loadUser).toHaveBeenCalledTimes(3);
    const generic = await server.app.inject({ method: 'POST', url: '/api/conversations', payload: { agent: { llm_profile_ref: 'main', tools: [], condenser: { enabled: false } } } });
    expect(generic.statusCode).toBe(201); expect(loadPublic).toHaveBeenCalledTimes(3); expect(loadUser).toHaveBeenCalledTimes(3);
    expect(complete).not.toHaveBeenCalled();
  } finally { await server.app.close(); await rm(root, { recursive: true, force: true }); }
});
