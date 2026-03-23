import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  loadSkillsFromDir,
  type Skill,
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
