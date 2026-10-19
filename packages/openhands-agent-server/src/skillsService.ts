import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  cachedGitFetcher, DEFAULT_MARKETPLACE_PATH, fetchWithResolution, getCachePath, invalidatePublicSkillsCache,
  isCachedGitPinned, loadPublicSkills, loadSkillsFromDir, loadUserSkills, LocalFileStore, parseExtensionSource,
  parseSkillsMarketplace, PUBLIC_SKILLS_REPO, Skill, skillSchema, type PublicSkillsOptions, type SkillsMarketplace,
} from '@smolpaws/openhands-agent';
import { installedSkillNameSchema, installedSkillResponseSchema, type InstalledSkillInfo, type InstallSkillRequest,
  type MarketplaceRegistration, type MarketplaceSkillInfo, type SkillsRequest } from './skillsModels.js';

export class SkillsServiceError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export interface SkillsCatalogOptions {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly publicOptions?: PublicSkillsOptions;
  readonly userDirectories?: readonly string[];
  readonly registeredMarketplaces?: readonly MarketplaceRegistration[];
  readonly clock?: () => number;
  readonly loadPublic?: (marketplacePath: string | null) => Promise<readonly Skill[]>;
  readonly loadUser?: () => Promise<readonly Skill[]>;
  readonly loadProject?: (directory: string) => Promise<readonly Skill[]>;
  readonly loadOrg?: (configs: NonNullable<SkillsRequest['org_configs']>) => Promise<readonly Skill[]>;
  readonly loadRegisteredMarketplaces?: (registrations: readonly MarketplaceRegistration[]) => Promise<readonly Skill[]>;
  /** Actual repository update. Strict failures must reject; returned path must exist. */
  readonly updateRepository?: (strict: boolean) => Promise<string>;
}
type CatalogEntry = Omit<MarketplaceSkillInfo, 'installed'>;

/** One catalog owner for HTTP discovery, launch snapshots, and installed-skill state. */
export class SkillsCatalogService {
  private readonly installedDir: string;
  private readonly cacheDir: string;
  private readonly clock: () => number;
  private catalogCache: { at: number; entries: CatalogEntry[] } | null = null;
  constructor(private readonly options: SkillsCatalogOptions) {
    this.installedDir = path.resolve(options.stateDir, 'skills', 'installed');
    this.cacheDir = path.resolve(options.stateDir, 'skills', '.cache');
    this.clock = options.clock ?? (() => performance.now());
  }

  private async updateRepository(strict: boolean): Promise<string> {
    if (this.options.updateRepository) return this.options.updateRepository(strict);
    const options = this.options.publicOptions;
    const url = options?.repoUrl ?? PUBLIC_SKILLS_REPO;
    const ref = options?.ref ?? process.env.EXTENSIONS_REF ?? 'main';
    if (options?.fetchRepository) return (await options.fetchRepository(url, ref, { strict })).path;
    const destination = getCachePath(url, options?.cacheDirectory ?? this.cacheDir);
    await cachedGitFetcher(url, destination, { ref, update: true, strict });
    return destination;
  }

  private async publicSkills(marketplacePath: string | null): Promise<readonly Skill[]> {
    if (this.options.loadPublic) return this.options.loadPublic(marketplacePath);
    return loadPublicSkills({ ...this.options.publicOptions, marketplacePath, cacheDirectory: this.options.publicOptions?.cacheDirectory ?? this.cacheDir,
      fetchRepository: async (_url, _ref, { strict }) => { const directory = await this.updateRepository(strict); return { path: directory, pinned: await isCachedGitPinned(directory) }; } });
  }

  private async userSkills(): Promise<readonly Skill[]> {
    if (this.options.loadUser) return this.options.loadUser();
    return loadUserSkills({ ...(this.options.userDirectories === undefined ? {} : { directories: this.options.userDirectories }),
      installedDirectory: this.installedDir, loadInstalled: async () => {
        const result: Skill[] = [];
        for (const entry of await this.listInstalled()) if (entry.enabled) {
          try { result.push(await Skill.load(path.join(entry.install_path, 'SKILL.md'), entry.install_path, true)); } catch { /* Skip a corrupted installed entry. */ }
        }
        return result;
      } });
  }

  async discoverProfileCatalog(): Promise<{ skills: readonly Skill[]; publicSkillNames: readonly string[] }> {
    const [publicSkills, userSkills] = await Promise.all([this.publicSkills(DEFAULT_MARKETPLACE_PATH), this.userSkills()]);
    const userNames = new Set(userSkills.map(skill => skill.name));
    return { skills: mergeSkills(publicSkills, userSkills), publicSkillNames: [...new Set(publicSkills.map(skill => skill.name))].filter(name => !userNames.has(name)) };
  }

  async load(request: SkillsRequest): Promise<{ skills: Skill[]; sources: Record<string, number> }> {
    const registrations = new Map((this.options.registeredMarketplaces ?? []).map(entry => [entry.name, entry]));
    for (const entry of request.registered_marketplaces) registrations.set(entry.name, entry);
    const autoLoad = [...registrations.values()].filter(entry => Array.isArray(entry.auto_load) ? entry.auto_load.length > 0 : entry.auto_load);
    if (request.load_public && autoLoad.length && !this.options.loadRegisteredMarketplaces) throw new SkillsServiceError(501, 'Registered marketplace loading requires a host adapter');
    if (request.load_org && request.org_configs?.length && !this.options.loadOrg) throw new SkillsServiceError(501, 'Organization skill loading requires a host adapter');
    const urls = request.sandbox_config?.exposed_urls.filter(url => url.name.startsWith('WORKER_')) ?? [];
    const sandbox = urls.length ? [skillSchema.parse({ name: 'work_hosts', content: `The user has access to the following hosts for accessing a web application, each of which has a corresponding port:\n${urls.map(url => `* ${url.url} (port ${url.port})`).join('\n')}` })] : [];
    const registered = request.load_public && autoLoad.length ? await this.options.loadRegisteredMarketplaces!(autoLoad) : [];
    const base = mergeSkills(request.load_public ? await this.publicSkills(request.marketplace_path) : [], request.load_user ? await this.userSkills() : []);
    const org = request.load_org && request.org_configs?.length ? await this.options.loadOrg!(request.org_configs) : [];
    const project = request.load_project ? await (this.options.loadProject ?? loadProjectSkills)(request.project_dir ?? this.options.workspaceRoot) : [];
    return { skills: mergeSkills(sandbox, registered, base, org, project), sources: { sandbox: sandbox.length, registered_marketplaces: registered.length, sdk_base: base.length, org: org.length, project: project.length } };
  }

  async syncPublicSkills(): Promise<{ status: 'success' | 'error'; message: string }> {
    try {
      const directory = await this.updateRepository(true);
      if (!(await lstat(directory)).isDirectory()) throw new Error('Missing repository');
      invalidatePublicSkillsCache(); this.catalogCache = null;
      return { status: 'success', message: 'Skills repository synced successfully' };
    } catch { return { status: 'error', message: 'Failed to sync skills repository' }; }
  }

  async marketplaceCatalog(): Promise<MarketplaceSkillInfo[]> {
    const now = this.clock();
    let entries = this.catalogCache && now - this.catalogCache.at < 300_000 ? this.catalogCache.entries : null;
    if (entries === null) {
      entries = await this.fetchCatalog();
      if (entries.length) this.catalogCache = { at: now, entries };
    }
    const installed = new Set((await this.listInstalled()).map(skill => skill.name));
    return entries.map(entry => ({ ...entry, installed: installed.has(entry.name) }));
  }

  private async fetchCatalog(): Promise<CatalogEntry[]> {
    try {
      const directory = await this.updateRepository(false);
      const requested = path.resolve(directory, this.options.publicOptions?.marketplacePath ?? DEFAULT_MARKETPLACE_PATH);
      if (!within(path.resolve(directory), requested)) return [];
      await readFile(requested, 'utf8'); // Source requires the requested file even when an embedded manifest exists.
      let marketplace: SkillsMarketplace | undefined;
      for (const relative of ['.plugin/marketplace.json', '.claude-plugin/marketplace.json']) {
        const candidate = path.join(directory, relative);
        if (!await pathExists(candidate)) continue;
        try { marketplace = parseSkillsMarketplace(JSON.parse(await readFile(candidate, 'utf8'))); } catch { /* Invalid first embedded manifest falls back to the requested file. */ }
        break;
      }
      marketplace ??= parseSkillsMarketplace(JSON.parse(await readFile(requested, 'utf8')));
      const entries = new Map<string, CatalogEntry>();
      for (const plugin of marketplace.plugins) {
        let source: string;
        if (typeof plugin.source === 'string') {
          source = plugin.source.startsWith('/') || plugin.source.startsWith('~') || plugin.source.includes('://') ? plugin.source : path.join(directory, plugin.source.replace(/^[./]+/u, ''));
        } else {
          const value = plugin.source;
          if (value.source === 'github' && value.repo) source = `github:${value.repo}`;
          else if (value.source === 'url' && value.url) source = value.url;
          else throw new Error('Unsupported marketplace source');
          if (value.ref) source += `@${value.ref}`;
          if (value.path) source += `/${value.path}`;
        }
        entries.set(plugin.name, { name: plugin.name, description: plugin.description ?? null, source });
      }
      for (const skill of marketplace.skills) if (!entries.has(skill.name)) entries.set(skill.name, { name: skill.name, description: skill.description ?? null, source: skill.source });
      return [...entries.values()];
    } catch { return []; }
  }

  async listInstalled(): Promise<InstalledSkillInfo[]> {
    if (!await this.storageExists()) return [];
    const result: InstalledSkillInfo[] = [];
    for (const entry of await readdir(this.installedDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !installedSkillNameSchema.safeParse(entry.name).success) continue;
      const skill = await this.getInstalled(entry.name); if (skill) result.push(skill);
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async getInstalled(name: string): Promise<InstalledSkillInfo | null> {
    validateName(name);
    if (!await this.storageExists()) return null;
    const directory = path.join(this.installedDir, name);
    try {
      await directoryWithoutSymlink(directory);
      const file = path.join(directory, 'metadata.json');
      if (!(await lstat(file)).isFile()) return null;
      const result = installedSkillResponseSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      return result.success && result.data.name === name ? { ...result.data, install_path: directory } : null;
    } catch (error) { if (error instanceof SkillsServiceError) throw error; return null; }
  }

  async install(request: InstallSkillRequest): Promise<InstalledSkillInfo> {
    return this.mutate(async () => this.publishLocal(request));
  }
  async refresh(name: string): Promise<InstalledSkillInfo | null> {
    validateName(name);
    return this.mutate(async () => {
      const current = await this.getInstalled(name); if (!current) return null;
      return this.publishLocal({ source: current.source, ref: null, repo_path: current.repo_path, force: true }, current);
    });
  }
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    validateName(name);
    return this.mutate(async () => {
      const current = await this.getInstalled(name); if (!current) return false;
      const directory = path.join(this.installedDir, name);
      const temporary = path.join(directory, `.metadata-${randomUUID()}`);
      try { await writeFile(temporary, metadata({ ...current, enabled }), { flag: 'wx' }); await rename(temporary, path.join(directory, 'metadata.json')); }
      finally { await rm(temporary, { force: true }); }
      return true;
    });
  }
  async uninstall(name: string): Promise<boolean> {
    validateName(name);
    return this.mutate(async () => {
      if (!await this.getInstalled(name)) return false;
      await rm(path.join(this.installedDir, name), { recursive: true }); return true;
    });
  }

  private async storageExists(): Promise<boolean> {
    for (const directory of [path.dirname(this.installedDir), this.installedDir]) {
      try { await directoryWithoutSymlink(directory); } catch (error) { if (missing(error)) return false; throw error; }
    }
    return true;
  }
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await mkdir(path.resolve(this.options.stateDir), { recursive: true });
      for (const directory of [path.dirname(this.installedDir), this.installedDir]) {
        try { await mkdir(directory); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
        await directoryWithoutSymlink(directory);
      }
      return await new LocalFileStore(path.dirname(this.installedDir)).lockAsync('.installed.lock', operation, { recoverStaleLocks: false, timeoutSeconds: 5 });
    } catch (error) {
      if (error instanceof SkillsServiceError) throw error;
      throw new SkillsServiceError(500, 'Skill storage operation failed');
    }
  }

  private async publishLocal(request: InstallSkillRequest, previous?: InstalledSkillInfo): Promise<InstalledSkillInfo> {
    let source: string;
    try {
      const parsed = parseExtensionSource(request.source);
      if (parsed.type !== 'local') throw new SkillsServiceError(400, 'Remote skill installation is not available');
      const original = path.resolve(parsed.url.startsWith('~/') ? path.join(homedir(), parsed.url.slice(2)) : parsed.url);
      await directoryWithoutSymlink(original);
      source = (await fetchWithResolution(request.source, this.cacheDir, { repoPath: request.repo_path, ref: request.ref })).path;
      await directoryWithoutSymlink(source);
      const physicalSource = await realpath(source); const physicalInstalled = await realpath(this.installedDir);
      if (within(physicalSource, physicalInstalled) || within(physicalInstalled, physicalSource)) throw new SkillsServiceError(422, 'Skill source overlaps installed storage');
    } catch (error) {
      if (error instanceof SkillsServiceError) throw error;
      throw new SkillsServiceError(400, 'Skill source is unavailable or outside its repository');
    }
    let skill: Skill;
    try {
      if (!(await lstat(path.join(source, 'SKILL.md'))).isFile()) throw new Error('Invalid skill file');
      skill = await Skill.load(path.join(source, 'SKILL.md'), source, true);
      validateName(skill.name);
      if (!skill.isAgentskillsFormat) throw new Error('Expected AgentSkills format');
    } catch { throw new SkillsServiceError(422, 'Invalid skill definition'); }
    const name = previous?.name ?? skill.name; validateName(name);
    const target = path.join(this.installedDir, name);
    const existing = await pathExists(target);
    if (existing) { await directoryWithoutSymlink(target); if (!request.force) throw new SkillsServiceError(409, 'Skill already installed'); }
    const staged = await mkdtemp(path.join(this.installedDir, '.staging-'));
    const backup = path.join(this.installedDir, `.previous-${randomUUID()}`);
    let movedPrevious = false;
    try {
      await copyContainedTree(source, staged);
      const info: InstalledSkillInfo = { name, version: skill.version, description: skill.description ?? '', enabled: previous?.enabled ?? true,
        source: request.source, resolved_ref: null, repo_path: request.repo_path, installed_at: new Date().toISOString(), install_path: target };
      if (previous && skill.name !== previous.name) throw new SkillsServiceError(422, 'Refreshed skill name differs from its installation');
      await writeFile(path.join(staged, 'metadata.json'), metadata(info));
      if (existing) { await rename(target, backup); movedPrevious = true; }
      try { await rename(staged, target); } catch (error) { if (movedPrevious) { await rename(backup, target); movedPrevious = false; } throw error; }
      if (movedPrevious) await rm(backup, { recursive: true, force: true });
      return info;
    } finally { await rm(staged, { recursive: true, force: true }); }
  }
}

export function skillInfo(skill: Skill) {
  return { name: skill.name, type: skill.getSkillType(), content: skill.content, triggers: skill.getTriggers(), source: skill.source,
    description: skill.description, is_agentskills_format: skill.isAgentskillsFormat, disable_model_invocation: skill.disableModelInvocation };
}
function mergeSkills(...tiers: readonly (readonly Skill[])[]): Skill[] { const merged = new Map<string, Skill>(); for (const skills of tiers) for (const skill of skills) merged.set(skill.name, skill); return [...merged.values()]; }
async function loadProjectSkills(directory: string): Promise<Skill[]> {
  const loaded = await loadSkillsFromDir(path.join(directory, '.openhands', 'skills'));
  return [...Object.values(loaded.repoSkills), ...Object.values(loaded.knowledgeSkills), ...Object.values(loaded.agentSkills)];
}
function validateName(name: string): void { if (!installedSkillNameSchema.safeParse(name).success) throw new SkillsServiceError(422, 'Invalid installed skill name'); }
function metadata(info: InstalledSkillInfo): string { return `${JSON.stringify(info, null, 2)}\n`; }
function within(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
async function pathExists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function directoryWithoutSymlink(directory: string): Promise<void> { if (!(await lstat(directory)).isDirectory()) throw new SkillsServiceError(422, 'Skill directory must not be a symbolic link'); }
async function copyContainedTree(source: string, destination: string): Promise<void> {
  const physicalRoot = await realpath(source);
  const copy = async (from: string, to: string): Promise<void> => {
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'metadata.json' && from === source) continue;
      const input = path.join(from, entry.name); const output = path.join(to, entry.name); const info = await lstat(input);
      if (info.isSymbolicLink()) {
        let target: string;
        try { target = await realpath(path.resolve(path.dirname(input), await readlink(input))); } catch { throw new SkillsServiceError(422, 'Skill resource link is broken or cyclic'); }
        if (!within(physicalRoot, target) || (await lstat(target)).isDirectory() && within(target, await realpath(from))) throw new SkillsServiceError(422, 'Skill resource link escapes or cycles within its source');
        await symlink(path.relative(path.dirname(output), path.join(destination, path.relative(physicalRoot, target))), output);
      } else if (info.isDirectory()) { await mkdir(output); await copy(input, output); }
      else if (info.isFile()) await copyFile(input, output);
      else throw new SkillsServiceError(422, 'Unsupported skill resource file');
    }
  };
  await copy(source, destination);
}
