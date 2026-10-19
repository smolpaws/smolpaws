import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSkillsRoutes } from '../skillsRouter.js';
import { SkillsCatalogService } from '../skillsService.js';
import { skillsRequestSchema } from '../skillsModels.js';
import { Skill, skillSchema } from '@smolpaws/openhands-agent';

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), 'server04-skills-')); roots.push(root); return root; }
async function skill(directory: string, name = 'demo', content = 'Original content') {
  await mkdir(path.join(directory, 'resources'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture skill\n---\n${content}\n`);
  await writeFile(path.join(directory, 'resources', 'data.txt'), content);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('truthful skills HTTP operations', () => {
  it('reports a strict repository failure rather than a successful no-op', async () => {
    const root = await fixture(); const app = Fastify();
    const syncPublicSkills = vi.fn(async () => ({ status: 'error', message: 'Failed to sync skills repository' }));
    registerSkillsRoutes(app, { stateDir: root, workspaceRoot: root, service: { syncPublicSkills } } as never);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/skills/sync' });
      expect(response.json().status).toBe('error');
      expect(syncPublicSkills).toHaveBeenCalledOnce();
    } finally { await app.close(); }
  });

  it('copies resources, reports local provenance honestly and actually refreshes bytes', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(source);
    const app = Fastify(); registerSkillsRoutes(app, { stateDir: path.join(root, 'state'), workspaceRoot: root });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/skills/install', payload: { source, ref: 'not-a-resolved-git-sha' } });
      expect(response.statusCode).toBe(200);
      const installed = response.json();
      expect(installed.resolved_ref).toBeNull();
      expect(await readFile(path.join(installed.install_path, 'resources/data.txt'), 'utf8')).toBe('Original content');
      await app.inject({ method: 'PATCH', url: '/api/skills/installed/demo', payload: { enabled: false } });
      await skill(source, 'demo', 'Updated content');
      const refreshed = await app.inject({ method: 'POST', url: '/api/skills/installed/demo/refresh' });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().skill.enabled).toBe(false);
      expect(await readFile(path.join(installed.install_path, 'resources/data.txt'), 'utf8')).toBe('Updated content');
    } finally { await app.close(); }
  });
});

const definition = (name: string, content = name): Skill => skillSchema.parse({ name, content });
const request = (overrides: Record<string, unknown> = {}) => skillsRequestSchema.parse({ load_project: false, ...overrides });
async function catalog(directory: string, entries: unknown[] = [{ name: 'demo', source: './skills/demo', description: 'Demo' }]) {
  await mkdir(path.join(directory, 'marketplaces'), { recursive: true });
  await writeFile(path.join(directory, 'marketplaces/default.json'), JSON.stringify({ name: 'fixture', owner: { name: 'Fixture' }, plugins: entries, skills: [{ name: 'demo', source: 'wrong-duplicate' }, { name: 'standalone', source: 'github:fixture/skills/standalone' }] }));
}
describe('shared skills catalog', () => {
  it('loads one coherent public/user snapshot, applies user precedence and excludes shadowed public names', async () => {
    const root = await fixture(); const loadPublic = vi.fn(async () => [definition('public'), definition('shared', 'public')]);
    const loadUser = vi.fn(async () => [definition('user'), definition('shared', 'user')]);
    const service = new SkillsCatalogService({ stateDir: root, workspaceRoot: root, loadPublic, loadUser });
    const snapshot = await service.discoverProfileCatalog();
    expect(snapshot.skills.map(s => [s.name, s.content])).toEqual([['public', 'public'], ['shared', 'user'], ['user', 'user']]);
    expect(snapshot.publicSkillNames).toEqual(['public']); expect(loadPublic).toHaveBeenCalledOnce(); expect(loadUser).toHaveBeenCalledOnce();
    expect((await service.load(request())).skills.map(s => [s.name, s.content])).toEqual(snapshot.skills.map(s => [s.name, s.content]));
  });

  it('caches only nonempty marketplace structure for 300 seconds and refreshes installed state every read', async () => {
    const root = await fixture(); const repo = path.join(root, 'repo'); await catalog(repo); await skill(path.join(repo, 'skills/demo'));
    let now = 0; const updateRepository = vi.fn(async () => repo);
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root, userDirectories: [], updateRepository, clock: () => now });
    expect(await service.marketplaceCatalog()).toEqual([{ name: 'demo', description: 'Demo', source: path.join(repo, 'skills/demo'), installed: false }, { name: 'standalone', description: null, source: 'github:fixture/skills/standalone', installed: false }]);
    await service.install({ source: path.join(repo, 'skills/demo'), ref: null, repo_path: null, force: false });
    await service.setEnabled('demo', false);
    expect((await service.marketplaceCatalog())[0]?.installed).toBe(true); expect(updateRepository).toHaveBeenCalledTimes(1);
    await service.uninstall('demo'); now = 299_999;
    expect((await service.marketplaceCatalog())[0]?.installed).toBe(false); expect(updateRepository).toHaveBeenCalledTimes(1);
    now = 300_000; await service.marketplaceCatalog(); expect(updateRepository).toHaveBeenCalledTimes(2);
  });

  it('retries empty/failed catalogs, resolves structured sources, and invalidates caches only after successful strict sync', async () => {
    const root = await fixture(); const repo = path.join(root, 'repo'); await mkdir(repo);
    let fail = false; const updateRepository = vi.fn(async () => { if (fail) throw new Error('https://token-secret@example.test'); return repo; });
    const service = new SkillsCatalogService({ stateDir: root, workspaceRoot: root, updateRepository, userDirectories: [] });
    expect(await service.marketplaceCatalog()).toEqual([]); expect(await service.marketplaceCatalog()).toEqual([]); expect(updateRepository).toHaveBeenCalledTimes(2);
    await catalog(repo, [{ name: 'remote', source: { source: 'github', repo: 'fixture/repo', ref: 'v1', path: 'skills/one' } }]);
    expect((await service.marketplaceCatalog())[0]?.source).toBe('github:fixture/repo@v1/skills/one');
    fail = true; expect(await service.syncPublicSkills()).toEqual({ status: 'error', message: 'Failed to sync skills repository' });
    expect(updateRepository).toHaveBeenLastCalledWith(true);
    expect((await service.marketplaceCatalog())[0]?.name).toBe('remote'); expect(updateRepository).toHaveBeenCalledTimes(4);
    fail = false; await catalog(repo, [{ name: 'new', source: './skills/new' }]);
    expect((await service.syncPublicSkills()).status).toBe('success');
    expect((await service.marketplaceCatalog())[0]?.name).toBe('new'); expect(updateRepository).toHaveBeenCalledTimes(6);
  });

  it('rejects unsupported effective organization/registration loads, but ignores disabled or empty requests', async () => {
    const root = await fixture(); const service = new SkillsCatalogService({ stateDir: root, workspaceRoot: root, loadPublic: async () => [], loadUser: async () => [] });
    const org_configs = [{ repository: 'owner/repo', provider: 'github', org_repo_url: 'https://secret@example.test', org_name: 'Fixture' }];
    await expect(service.load(request({ org_configs }))).rejects.toMatchObject({ statusCode: 501, message: 'Organization skill loading requires a host adapter' });
    const registered_marketplaces = [{ name: 'test', source: 'github:fixture/repo', auto_load: true }];
    await expect(service.load(request({ registered_marketplaces }))).rejects.toMatchObject({ statusCode: 501 });
    expect((await service.load(request({ org_configs, load_org: false, registered_marketplaces, load_public: false }))).skills).toEqual([]);
    expect((await service.load(request({ registered_marketplaces: [{ ...registered_marketplaces[0], auto_load: [] }] }))).skills).toEqual([]);
  });

  it('accepts explicit host loaders and lets request registrations override server entries by name', async () => {
    const root = await fixture(); const loadPublic = vi.fn(async () => [definition('shared', 'public')]);
    const loadRegisteredMarketplaces = vi.fn(async () => [definition('shared', 'marketplace')]);
    const service = new SkillsCatalogService({ stateDir: root, workspaceRoot: root, loadPublic, loadUser: async () => [], loadRegisteredMarketplaces,
      loadOrg: async () => [definition('shared', 'org')], registeredMarketplaces: [{ name: 'same', source: 'server', ref: null, repo_path: null, auto_load: true }] });
    const disabled = await service.load(request({ marketplace_path: null, registered_marketplaces: [{ name: 'same', source: 'request', auto_load: false }] }));
    expect(disabled.skills.map(s => s.content)).toEqual(['public']); expect(loadPublic).toHaveBeenCalledWith(null); expect(loadRegisteredMarketplaces).not.toHaveBeenCalled();
    const selected = await service.load(request({ registered_marketplaces: [{ name: 'same', source: 'request', auto_load: ['one'] }],
      org_configs: [{ repository: 'fixture/repo', provider: 'github', org_repo_url: 'https://fixture.test', org_name: 'Fixture' }] }));
    expect(loadRegisteredMarketplaces).toHaveBeenCalledWith([{ name: 'same', source: 'request', ref: null, repo_path: null, auto_load: ['one'] }]);
    expect(selected.skills.map(s => s.content)).toEqual(['org']);
  });

  it('loads sandbox and project tiers with the source precedence and counts', async () => {
    const root = await fixture(); const service = new SkillsCatalogService({ stateDir: root, workspaceRoot: root, loadPublic: async () => [definition('work_hosts', 'public')], loadUser: async () => [], loadProject: async () => [definition('work_hosts', 'project')] });
    const sandbox_config = { exposed_urls: [{ name: 'WORKER_APP', url: 'https://fixture.test', port: 8080 }, { name: 'OTHER', url: 'https://excluded.test', port: 3 }] };
    const first = await service.load(request({ load_public: false, sandbox_config }));
    expect(first.skills[0]?.content).toContain('* https://fixture.test (port 8080)'); expect(first.skills[0]?.content).not.toContain('excluded');
    const result = await service.load(request({ load_project: true, sandbox_config }));
    expect(result.skills.map(s => s.content)).toEqual(['project']);
    expect(result.sources).toEqual({ sandbox: 1, registered_marketplaces: 0, sdk_base: 1, org: 0, project: 1 });
  });

  it('falls back to the requested manifest when the first existing embedded manifest is invalid', async () => {
    const root = await fixture(); await catalog(root); await mkdir(path.join(root, '.plugin')); await mkdir(path.join(root, '.claude-plugin'));
    await writeFile(path.join(root, '.plugin/marketplace.json'), '{invalid');
    await writeFile(path.join(root, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'wrong-fallback', owner: { name: 'Fixture' }, plugins: [{ name: 'wrong', source: './wrong' }] }));
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root, updateRepository: async () => root });
    expect((await service.marketplaceCatalog()).map(entry => entry.name)).toEqual(['demo', 'standalone']);
  });

  it('reports a real unreachable Git origin and preserves both caches until a successful strict sync', async () => {
    const root = await fixture(); const origin = path.join(root, 'origin'); await catalog(origin); await skill(path.join(origin, 'skills/demo'));
    const run = promisify(execFile);
    const git = (...args: string[]) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-C', origin, ...args]);
    await git('init', '-b', 'main'); await git('add', '.'); await git('commit', '-m', 'fixture');
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root, userDirectories: [], publicOptions: { repoUrl: origin, ref: 'main' } });
    expect((await service.discoverProfileCatalog()).skills[0]?.content).toContain('Original content');
    expect((await service.marketplaceCatalog())[0]?.name).toBe('demo');
    await rename(origin, `${origin}-offline`);
    expect((await service.syncPublicSkills()).status).toBe('error');
    expect((await service.discoverProfileCatalog()).skills[0]?.content).toContain('Original content');
    expect((await service.marketplaceCatalog())[0]?.name).toBe('demo');
    await rename(`${origin}-offline`, origin); await skill(path.join(origin, 'skills/demo'), 'demo', 'Updated from origin');
    await catalog(origin, [{ name: 'demo', source: './skills/demo', description: 'Updated catalog' }]);
    await git('add', '.'); await git('commit', '-m', 'updated fixture');
    expect((await service.syncPublicSkills()).status).toBe('success');
    expect((await service.discoverProfileCatalog()).skills[0]?.content).toContain('Updated from origin');
    expect((await service.marketplaceCatalog())[0]?.description).toBe('Updated catalog');
  });
});

describe('contained local skill lifecycle', () => {
  it('uses the requested subpath, excludes disabled installed resources, and preserves the old tree on failed refresh', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(path.join(source, 'skills/demo'));
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root, loadPublic: async () => [], userDirectories: [] });
    const installed = await service.install({ source, ref: null, repo_path: 'skills/demo', force: false });
    expect((await service.discoverProfileCatalog()).skills.map(s => s.name)).toEqual(['demo']);
    await service.setEnabled('demo', false); expect((await service.discoverProfileCatalog()).skills).toEqual([]);
    const before = await readFile(path.join(installed.install_path, 'metadata.json'), 'utf8');
    await rm(path.join(source, 'skills/demo/SKILL.md'));
    await expect(service.refresh('demo')).rejects.toMatchObject({ statusCode: 422 });
    expect(await readFile(path.join(installed.install_path, 'metadata.json'), 'utf8')).toBe(before);
    expect(await readFile(path.join(installed.install_path, 'resources/data.txt'), 'utf8')).toBe('Original content');
  });

  it('rejects unsafe names, source roots, escaping subpaths and resource links before publishing', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(source);
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root, loadPublic: async () => [], userDirectories: [] });
    const install = (value: string, repo_path: string | null = null) => service.install({ source: value, ref: null, repo_path, force: false });
    await expect(service.getInstalled('../outside')).rejects.toMatchObject({ statusCode: 422 });
    await expect(install(source, '../outside')).rejects.toMatchObject({ statusCode: 400 });
    await symlink(source, path.join(root, 'linked')); await expect(install(path.join(root, 'linked'))).rejects.toMatchObject({ statusCode: 422 });
    await writeFile(path.join(root, 'secret.txt'), 'must not copy'); await symlink(path.join(root, 'secret.txt'), path.join(source, 'resources/escape'));
    await expect(install(source)).rejects.toMatchObject({ statusCode: 422 }); expect(await service.listInstalled()).toEqual([]);
    await rm(path.join(source, 'resources/escape')); await skill(source, '../outside');
    await expect(install(source)).rejects.toMatchObject({ statusCode: 422 });
    await expect(install('github:fixture/repo/skills/demo')).rejects.toMatchObject({ statusCode: 400, message: 'Remote skill installation is not available' });
  });

  it('copies contained links without references back to source and refuses symlinked installed storage', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(source);
    await symlink(path.join(source, 'resources/data.txt'), path.join(source, 'resources/link.txt'));
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root, userDirectories: [] });
    const installed = await service.install({ source, ref: null, repo_path: null, force: false });
    await rm(source, { recursive: true });
    expect(await readFile(path.join(installed.install_path, 'resources/link.txt'), 'utf8')).toBe('Original content');
    const other = path.join(root, 'other'); await mkdir(other); await mkdir(path.join(root, 'state2/skills'), { recursive: true });
    await symlink(other, path.join(root, 'state2/skills/installed'));
    const unsafe = new SkillsCatalogService({ stateDir: path.join(root, 'state2'), workspaceRoot: root, userDirectories: [] });
    await expect(unsafe.listInstalled()).rejects.toMatchObject({ statusCode: 422 });
  });

  it('rejects installing from its own managed store before staging can recurse into itself', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(source);
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root });
    const installed = await service.install({ source, ref: null, repo_path: null, force: false });
    await expect(service.install({ source: installed.install_path, ref: null, repo_path: null, force: false })).rejects.toMatchObject({ statusCode: 422, message: 'Skill source overlaps installed storage' });
  });

  it('serializes independent service instances and leaves one complete installation', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(source);
    const options = { stateDir: path.join(root, 'state'), workspaceRoot: root };
    const first = new SkillsCatalogService(options); const second = new SkillsCatalogService(options);
    const results = await Promise.allSettled([first, second].map(service => service.install({ source, ref: null, repo_path: null, force: false })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { statusCode: 409 } }]);
    expect(await second.listInstalled()).toHaveLength(1);
  });

  it('keeps the previous installation intact when resource validation or renamed identity blocks refresh', async () => {
    const root = await fixture(); const source = path.join(root, 'source'); await skill(source);
    const service = new SkillsCatalogService({ stateDir: path.join(root, 'state'), workspaceRoot: root });
    const installed = await service.install({ source, ref: null, repo_path: null, force: false });
    const before = await readFile(path.join(installed.install_path, 'metadata.json'), 'utf8');
    await symlink(root, path.join(source, 'resources/escape'));
    await expect(service.refresh('demo')).rejects.toMatchObject({ statusCode: 422 });
    await rm(path.join(source, 'resources/escape')); await skill(source, 'renamed', 'Changed bytes');
    await expect(service.refresh('demo')).rejects.toMatchObject({ statusCode: 422 });
    expect(await readFile(path.join(installed.install_path, 'metadata.json'), 'utf8')).toBe(before);
    expect(await readFile(path.join(installed.install_path, 'resources/data.txt'), 'utf8')).toBe('Original content');
    expect((await service.listInstalled()).map(info => info.name)).toEqual(['demo']);
  });

  it('does not expose source URLs or filesystem errors in HTTP error details', async () => {
    const root = await fixture(); const app = Fastify(); registerSkillsRoutes(app, { stateDir: root, workspaceRoot: root });
    try {
      const remote = await app.inject({ method: 'POST', url: '/api/skills/install', payload: { source: 'https://token-secret@example.test/repo.git' } });
      expect(remote.statusCode).toBe(400); expect(remote.body).not.toContain('token-secret');
      const unsafe = await app.inject({ method: 'DELETE', url: '/api/skills/installed/..%2foutside' });
      expect(unsafe.statusCode).toBe(422);
      const missing = await app.inject({ method: 'POST', url: '/api/skills/installed/missing/refresh' }); expect(missing.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
