import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RunnerEnv } from './workspacePolicy.js';
import {
  isAllowedWorkspacePath,
  listAllowedWorkspaceRoots,
} from './workspacePolicy.js';

const tempRoots: string[] = [];

function createEnv(workspaceRoot: string, extraAllowedRoots?: string): RunnerEnv {
  return {
    SMOLPAWS_WORKSPACE_ROOT: workspaceRoot,
    SMOLPAWS_ALLOWED_WRITE_ROOTS: extraAllowedRoots,
  };
}

test('listAllowedWorkspaceRoots includes configured extra roots', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-allowed-roots-'));
  tempRoots.push(tempRoot);
  const workspaceRoot = path.join(tempRoot, 'smolpaws', 'groups', 'main');
  const reposRoot = path.join(tempRoot, 'repos');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(reposRoot, { recursive: true });

  const roots = listAllowedWorkspaceRoots(
    createEnv(workspaceRoot, reposRoot),
  ).sort();

  assert.deepEqual(roots, [path.resolve(reposRoot), path.resolve(workspaceRoot)].sort());
});

test('isAllowedWorkspacePath allows writes under extra allowed roots', async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'smolpaws-allowed-write-'));
  tempRoots.push(tempRoot);
  const workspaceRoot = path.join(tempRoot, 'smolpaws', 'groups', 'main');
  const reposRoot = path.join(tempRoot, 'repos');
  const memoryFile = path.join(reposRoot, 'smolpaws', 'docs', 'smolpaws', 'MEMORY.md');
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(path.dirname(memoryFile), { recursive: true });
  writeFileSync(memoryFile, '# durable memory\n');

  const baseEnv = createEnv(workspaceRoot);
  const expandedEnv = createEnv(workspaceRoot, reposRoot);

  assert.equal(await isAllowedWorkspacePath(memoryFile, baseEnv, 'write'), false);
  assert.equal(await isAllowedWorkspacePath(memoryFile, expandedEnv, 'write'), true);
});

test.after(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
