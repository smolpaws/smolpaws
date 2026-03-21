import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RunnerEnv } from '../runner/workspacePolicy.js';
import type { SmolpawsConversationConfigValue } from '../shared/runner.js';
import { loadProjectSkills, resolveProjectSkillsRoot } from './projectSkills.js';

function createEnv(rootDir: string, defaultWorkingDir = 'smolpaws'): RunnerEnv {
  return {
    SMOLPAWS_RUNNER_TOKEN: undefined,
    SMOLPAWS_WORKSPACE_ROOT: rootDir,
    SMOLPAWS_DEFAULT_WORKING_DIR: defaultWorkingDir,
  };
}

test('resolveProjectSkillsRoot prefers the GitHub repo clone when present', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-project-root-'));
  const defaultRoot = path.join(tempRoot, 'smolpaws');
  const githubRepoRoot = path.join(tempRoot, '.openhands');
  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(githubRepoRoot, { recursive: true });

  const config: SmolpawsConversationConfigValue = {
    github: {
      repository_full_name: 'enyst/.openhands',
    },
  };

  const resolved = resolveProjectSkillsRoot({
    workspaceRoot: defaultRoot,
    env: createEnv(tempRoot),
    smolpawsConfig: config,
  });

  assert.equal(resolved, githubRepoRoot);
});

test('loadProjectSkills loads repo files and AgentSkills-format skills', () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-project-skills-'));
  mkdirSync(path.join(repoRoot, '.git'));
  mkdirSync(path.join(repoRoot, '.agents', 'skills', 'demo-skill'), {
    recursive: true,
  });
  writeFileSync(path.join(repoRoot, 'AGENTS.md'), 'Repository guidance');
  writeFileSync(
    path.join(repoRoot, '.agents', 'skills', 'demo-skill', 'SKILL.md'),
    [
      '---',
      'name: demo-skill',
      'description: Demonstrates project skill loading',
      '---',
      '# Demo skill',
      'Use this when asked to demo.',
      '',
    ].join('\n'),
  );

  const skills = loadProjectSkills(repoRoot);
  const skillNames = skills.map((skill) => skill.name).sort();

  assert.deepEqual(skillNames, ['agents', 'demo-skill']);
  assert.equal(skills.find((skill) => skill.name === 'demo-skill')?.isAgentSkillsFormat, true);
});
