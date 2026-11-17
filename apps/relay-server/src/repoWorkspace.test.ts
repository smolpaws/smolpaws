import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { githubWorkingDir } from './repoWorkspace.js';

test('GitHub workspaces honor repo mappings and reject paths and symlinks outside the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'repo-workspace-'));
  try {
    const repos = path.join(root, 'repos'); mkdirSync(repos); mkdirSync(path.join(repos, 'sdk')); mkdirSync(path.join(repos, 'plain'));
    const map = path.join(root, 'repo-map.json'); writeFileSync(map, JSON.stringify({ 'owner/upstream': 'sdk', 'owner/outside': '..' }));
    symlinkSync(root, path.join(repos, 'escape'));
    const env = { SMOLPAWS_WORKSPACE_ROOT: repos, SMOLPAWS_REPO_MAP_PATH: map };
    assert.equal(githubWorkingDir('owner/upstream', env), realpathSync(path.join(repos, 'sdk')));
    assert.equal(githubWorkingDir('owner/plain', env), realpathSync(path.join(repos, 'plain')));
    assert.equal(githubWorkingDir('owner/outside', env), undefined);
    assert.equal(githubWorkingDir('owner/escape', env), undefined);
    assert.equal(githubWorkingDir('owner/missing', env), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
