import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  loadSkillsFromDir,
  Skill,
} from '@smolpaws/agent-sdk';
import type { SmolpawsConversationConfigValue } from '../shared/runner.js';
import {
  getDefaultWorkingDir,
  type RunnerEnv,
} from '../runner/workspacePolicy.js';
import { resolveGithubRepoWorkspaceRoot } from './repoWorkspace.js';

const PROJECT_SKILL_DIRS = [
  ['.agents', 'skills'],
  ['.openhands', 'skills'],
  ['.openhands', 'microagents'],
] as const;

const SMOLPAWS_CONTEXT_DOCS = [
  ['docs', 'smolpaws', 'AGENTS.md', 'smolpaws-agents'],
  ['docs', 'smolpaws', 'IDENTITY.md', 'smolpaws-identity'],
  ['docs', 'smolpaws', 'USER.md', 'smolpaws-user'],
  ['docs', 'smolpaws', 'TOOLS.md', 'smolpaws-tools'],
] as const;

function isDirectory(dirPath: string): boolean {
  return existsSync(dirPath) && statSync(dirPath).isDirectory();
}

function findGitRepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (isDirectory(current)) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

function mergeLoadedSkills(
  skillDir: string,
  seenNames: Set<string>,
  allSkills: Skill[],
): void {
  try {
    const { repoSkills, knowledgeSkills, agentSkills } = loadSkillsFromDir(skillDir);
    for (const skillMap of [repoSkills, knowledgeSkills, agentSkills]) {
      for (const [name, skill] of skillMap.entries()) {
        if (seenNames.has(name)) {
          continue;
        }
        seenNames.add(name);
        allSkills.push(skill);
      }
    }
  } catch (error) {
    console.warn(
      `Failed to load project skills from ${skillDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function loadProjectSkills(projectRoot: string): Skill[] {
  const normalizedRoot = path.resolve(projectRoot);
  const searchRoots = [normalizedRoot];
  const gitRoot = findGitRepoRoot(normalizedRoot);
  if (gitRoot && gitRoot !== normalizedRoot) {
    searchRoots.push(gitRoot);
  }

  const seenNames = new Set<string>();
  const allSkills: Skill[] = [];
  for (const root of searchRoots) {
    for (const relativePath of PROJECT_SKILL_DIRS) {
      mergeLoadedSkills(path.join(root, ...relativePath), seenNames, allSkills);
    }
  }
  return allSkills;
}

export function loadSmolpawsContextDocs(env: RunnerEnv): Skill[] {
  const repoRoot = path.resolve(getDefaultWorkingDir(env));
  const docs: Skill[] = [];

  for (const contextDoc of SMOLPAWS_CONTEXT_DOCS) {
    const skillName = contextDoc[contextDoc.length - 1];
    const filePath = path.join(repoRoot, ...contextDoc.slice(0, -1));
    if (!existsSync(filePath)) {
      continue;
    }

    docs.push(
      new Skill({
        name: skillName,
        content: readFileSync(filePath, 'utf-8'),
        trigger: null,
        source: filePath,
      }),
    );
  }

  return docs;
}

export function resolveProjectSkillsRoot(params: {
  workspaceRoot: string;
  env: RunnerEnv;
  smolpawsConfig?: SmolpawsConversationConfigValue;
}): string {
  const fallbackRoot = getDefaultWorkingDir(params.env);
  const candidates = [
    resolveGithubRepoWorkspaceRoot({
      env: params.env,
      smolpawsConfig: params.smolpawsConfig,
    }),
    params.workspaceRoot,
    fallbackRoot,
  ].filter((candidate): candidate is string => Boolean(candidate));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (isDirectory(normalized)) {
      return normalized;
    }
  }

  return path.resolve(fallbackRoot);
}
