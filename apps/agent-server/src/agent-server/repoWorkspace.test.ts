import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RunnerEnv } from '../runner/workspacePolicy.js';
import type { SmolpawsConversationConfigValue } from '../shared/runner.js';
import { resolveConversationWorkspaceRoot } from './repoWorkspace.js';

const tempRoots: string[] = [];

function createEnv(rootDir: string, options?: {
  defaultWorkingDir?: string;
  repoMapPath?: string;
}): RunnerEnv {
  return {
    SMOLPAWS_WORKSPACE_ROOT: rootDir,
    SMOLPAWS_DEFAULT_WORKING_DIR: options?.defaultWorkingDir ?? 'smolpaws',
    SMOLPAWS_REPO_MAP_PATH: options?.repoMapPath,
  };
}

function createGithubConfig(repositoryFullName: string): SmolpawsConversationConfigValue {
  return {
    github: {
      repository_full_name: repositoryFullName,
    },
  };
}

test('resolveConversationWorkspaceRoot prefers the same-name GitHub repo clone when present', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-repo-workspace-'));
  tempRoots.push(tempRoot);
  const defaultRoot = path.join(tempRoot, 'smolpaws');
  const githubRepoRoot = path.join(tempRoot, '.openhands');
  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(githubRepoRoot, { recursive: true });

  const resolved = resolveConversationWorkspaceRoot({
    env: createEnv(tempRoot),
    smolpawsConfig: createGithubConfig('enyst/.openhands'),
  });

  assert.equal(resolved, githubRepoRoot);
});

test('resolveConversationWorkspaceRoot honors ~/.smolpaws/repo-map.json overrides for mismatched local clone names', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-repo-map-'));
  tempRoots.push(tempRoot);
  const defaultRoot = path.join(tempRoot, 'smolpaws');
  const mappedRepoRoot = path.join(tempRoot, 'oh-tab');
  const repoMapPath = path.join(tempRoot, 'repo-map.json');
  mkdirSync(defaultRoot, { recursive: true });
  mkdirSync(mappedRepoRoot, { recursive: true });
  writeFileSync(
    repoMapPath,
    `${JSON.stringify({ 'OpenHands/OpenHands-Tab': 'oh-tab' }, null, 2)}\n`,
  );

  const resolved = resolveConversationWorkspaceRoot({
    env: createEnv(tempRoot, { repoMapPath }),
    smolpawsConfig: createGithubConfig('OpenHands/OpenHands-Tab'),
  });

  assert.equal(resolved, mappedRepoRoot);
});

test('resolveConversationWorkspaceRoot falls back to the default working dir when the target repo clone is unavailable', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-repo-fallback-'));
  tempRoots.push(tempRoot);
  const defaultRoot = path.join(tempRoot, 'smolpaws');
  mkdirSync(defaultRoot, { recursive: true });

  const resolved = resolveConversationWorkspaceRoot({
    env: createEnv(tempRoot),
    smolpawsConfig: createGithubConfig('enyst/missing-repo'),
  });

  assert.equal(resolved, defaultRoot);
});

test('resolveConversationWorkspaceRoot blocks GitHub repo names that would escape the configured root', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-repo-traversal-'));
  tempRoots.push(tempRoot);
  const defaultRoot = path.join(tempRoot, 'smolpaws');
  mkdirSync(defaultRoot, { recursive: true });

  const resolved = resolveConversationWorkspaceRoot({
    env: createEnv(tempRoot),
    smolpawsConfig: createGithubConfig('enyst/../../../etc'),
  });

  assert.equal(resolved, defaultRoot);
});

test.after(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
