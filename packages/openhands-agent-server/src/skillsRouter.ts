import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { FastifyInstance } from 'fastify';
import { loadSkillsFromDir, type Skill } from '@smolpaws/openhands-agent';

import {
  installSkillRequestSchema,
  skillsRequestSchema,
  updateSkillStateRequestSchema,
  type InstallSkillRequest,
} from './models.js';
import { param, parseBody } from './routeUtils.js';

interface InstalledSkillInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly resolved_ref: string | null;
  readonly repo_path: string | null;
  readonly installed_at: string;
  readonly install_path: string;
}

export function registerSkillsRoutes(app: FastifyInstance, options: { readonly stateDir: string; readonly workspaceRoot: string }): void {
  const installedDir = path.join(options.stateDir, 'skills', 'installed');

  app.post('/api/skills', async (request) => loadSkills(parseBody(skillsRequestSchema, request.body), options.workspaceRoot, installedDir));
  app.post('/api/skills/sync', async () => ({ status: 'success', message: 'Local TypeScript server does not maintain a public skills cache.' }));
  app.post('/api/skills/install', async (request, reply) => {
    try {
      const installed = await installLocalSkill(parseBody(installSkillRequestSchema, request.body), installedDir);
      reply.status(200);
      return installed;
    } catch (error) {
      reply.status(error instanceof Error && error.message === 'skill_exists' ? 409 : 400).send({ detail: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  });
  app.get('/api/skills/installed', async () => ({ skills: await listInstalled(installedDir) }));
  app.get('/api/skills/installed/:skill_name', async (request, reply) => {
    const skill = await getInstalled(installedDir, param(request, 'skill_name'));
    if (skill === null) {
      reply.status(404).send({ detail: 'Skill not installed' });
      return undefined;
    }
    return skill;
  });
  app.patch('/api/skills/installed/:skill_name', async (request, reply) => {
    const name = param(request, 'skill_name');
    const body = parseBody(updateSkillStateRequestSchema, request.body);
    const current = await getInstalled(installedDir, name);
    if (current === null) {
      reply.status(404).send({ detail: 'Skill not installed' });
      return undefined;
    }
    await writeMetadata(installedDir, name, { ...current, enabled: body.enabled });
    return { name, enabled: body.enabled };
  });
  app.delete('/api/skills/installed/:skill_name', async (request, reply) => {
    const name = param(request, 'skill_name');
    const current = await getInstalled(installedDir, name);
    if (current === null) {
      reply.status(404).send({ detail: 'Skill not installed' });
      return undefined;
    }
    await rm(path.join(installedDir, name), { recursive: true, force: true });
    return { message: `Skill '${name}' uninstalled` };
  });
  app.post('/api/skills/installed/:skill_name/refresh', async (request, reply) => {
    const name = param(request, 'skill_name');
    const current = await getInstalled(installedDir, name);
    if (current === null) {
      reply.status(404).send({ detail: 'Skill not installed' });
      return undefined;
    }
    return { message: `Skill '${name}' updated`, skill: current };
  });
  app.get('/api/skills/marketplace', async () => ({ skills: [] }));
}

async function loadSkills(request: { readonly load_user: boolean; readonly load_project: boolean; readonly project_dir: string | null }, workspaceRoot: string, installedDir: string) {
  const sources: Record<string, number> = {};
  const skills: Skill[] = [];
  const dirs: Array<readonly [string, string]> = [];
  dirs.push(['installed', installedDir]);
  if (request.load_user) dirs.push(['user', path.join(os.homedir(), '.openhands', 'skills')]);
  if (request.load_project) dirs.push(['project', path.join(request.project_dir ?? workspaceRoot, '.openhands', 'skills')]);
  for (const [source, dir] of dirs) {
    const loaded = await loadSkillsFromDir(dir).catch(() => ({ repoSkills: {}, knowledgeSkills: {}, agentSkills: {} }));
    const values = [...Object.values(loaded.repoSkills), ...Object.values(loaded.knowledgeSkills), ...Object.values(loaded.agentSkills)];
    sources[source] = values.length;
    skills.push(...values);
  }
  return { skills: skills.map(skillInfo), sources };
}

function skillInfo(skill: Skill) {
  return {
    name: skill.name,
    type: skill.getSkillType(),
    content: skill.content,
    triggers: skill.getTriggers(),
    source: skill.source,
    description: skill.description,
    is_agentskills_format: skill.isAgentskillsFormat,
    disable_model_invocation: skill.disableModelInvocation,
  };
}

async function installLocalSkill(request: InstallSkillRequest, installedDir: string): Promise<InstalledSkillInfo> {
  if (/^(?:https?:|git@|github:)/iu.test(request.source)) throw new Error('remote_skill_install_not_enabled');
  const source = path.resolve(request.source);
  const skillPath = (await stat(source)).isDirectory() ? path.join(source, 'SKILL.md') : source;
  const skill = await import('@smolpaws/openhands-agent').then(({ Skill }) => Skill.load(skillPath));
  const targetDir = path.join(installedDir, skill.name);
  if (!request.force && await exists(targetDir)) throw new Error('skill_exists');
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(targetDir, 'SKILL.md'), await readFile(skillPath, 'utf8'), 'utf8');
  const now = new Date().toISOString();
  const info: InstalledSkillInfo = { name: skill.name, version: skill.version, description: skill.description ?? '', enabled: true, source: request.source, resolved_ref: request.ref, repo_path: request.repo_path, installed_at: now, install_path: targetDir };
  await writeMetadata(installedDir, skill.name, info);
  return info;
}

async function listInstalled(installedDir: string): Promise<InstalledSkillInfo[]> {
  const entries = await readdir(installedDir, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => getInstalled(installedDir, entry.name)));
  return skills.filter((skill): skill is InstalledSkillInfo => skill !== null).sort((left, right) => left.name.localeCompare(right.name));
}

async function getInstalled(installedDir: string, name: string): Promise<InstalledSkillInfo | null> {
  return readFile(path.join(installedDir, name, 'metadata.json'), 'utf8').then((raw) => JSON.parse(raw) as InstalledSkillInfo).catch(() => null);
}

async function writeMetadata(installedDir: string, name: string, info: InstalledSkillInfo): Promise<void> {
  const dir = path.join(installedDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

async function exists(targetPath: string): Promise<boolean> {
  return stat(targetPath).then(() => true, () => false);
}
