import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RunnerEnv } from '../runner/workspacePolicy.js';
import type { SmolpawsConversationConfigValue } from '../shared/runner.js';
import {
  loadProjectSkills,
  loadSmolpawsContextDocs,
  resolveProjectSkillsRoot,
} from './projectSkills.js';

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

test('loadSmolpawsContextDocs loads the canonical smolpaws context files', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-context-docs-'));
  const defaultRoot = path.join(tempRoot, 'smolpaws');
  const contextDocsRoot = path.join(defaultRoot, 'docs', 'smolpaws');

  mkdirSync(contextDocsRoot, { recursive: true });
  mkdirSync(path.join(contextDocsRoot, 'memory'), { recursive: true });
  writeFileSync(path.join(contextDocsRoot, 'AGENTS.md'), '# SmolPaws Workspace\nHome den.\n');
  writeFileSync(path.join(contextDocsRoot, 'IDENTITY.md'), '# Identity\nsmolpaws.\n');
  writeFileSync(path.join(contextDocsRoot, 'MEMORY.md'), '# Memory\nKeep the good stuff.\n');
  writeFileSync(path.join(contextDocsRoot, 'README.md'), '# Readme\nSmolPaws context.\n');
  writeFileSync(path.join(contextDocsRoot, 'USER.md'), '# User\nEngel.\n');
  writeFileSync(path.join(contextDocsRoot, 'TOOLS.md'), '# Tools\n~/repos.\n');
  writeFileSync(path.join(contextDocsRoot, 'memory', '2026-03-24.md'), '# 2026-03-24\nDaily note.\n');

  const skills = loadSmolpawsContextDocs(createEnv(tempRoot));
  const skillData = skills
    .map((skill) => ({ name: skill.name, content: skill.content }))
    .sort((a, b) => a.name.localeCompare(b.name));

  assert.deepEqual(skillData, [
    { name: 'smolpaws-agents', content: '# SmolPaws Workspace\nHome den.\n' },
    { name: 'smolpaws-identity', content: '# Identity\nsmolpaws.\n' },
    { name: 'smolpaws-memory', content: '# Memory\nKeep the good stuff.\n' },
    { name: 'smolpaws-readme', content: '# Readme\nSmolPaws context.\n' },
    { name: 'smolpaws-tools', content: '# Tools\n~/repos.\n' },
    { name: 'smolpaws-user', content: '# User\nEngel.\n' },
  ]);
  assert.equal(existsSync(path.join(contextDocsRoot, 'memory', '2026-03-24.md')), true);
  assert.equal(skillData.some((skill) => skill.content.includes('Daily note.')), false);
});
