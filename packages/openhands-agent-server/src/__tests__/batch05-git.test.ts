import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { InMemorySecretStore } from '@smolpaws/openhands-agent';
import { expect, it } from 'vitest';

import { createAgentServerApp } from '../app.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd });
}
async function repository(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true }); await git(directory, 'init', '-q', '-b', 'main');
  await writeFile(join(directory, 'README.md'), 'hello\n');
  await git(directory, 'add', 'README.md'); await git(directory, 'commit', '-qm', 'initial');
}
async function edit(directory: string): Promise<void> {
  await writeFile(join(directory, 'README.md'), 'hello\nedit\n'); await writeFile(join(directory, 'notes.txt'), 'note\n');
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'server05-git-'));
  const server = await createAgentServerApp({ secretStore: new InMemorySecretStore(),
    config: { workspaceRoot: root, statePath: join(root, 'state'), conversationsPath: join(root, 'conversations'), bashEventsPath: join(root, 'bash') },
  });
  const changes = (path: string, ref?: string) => server.app.inject({ method: 'GET', url: `/api/git/changes?path=${encodeURIComponent(path)}${ref === undefined ? '' : `&ref=${encodeURIComponent(ref)}`}` });
  return { ...server, root, changes, async close() { await server.app.close(); await rm(root, { recursive: true, force: true }); } };
}

// Source d599513: tests/agent_server/test_git_router.py uses real Git in a
// parent/proj workspace, whose parent is deliberately not itself a repository.
it('lists nested tracked and untracked changes through query and wildcard routes', async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, 'workspace'); const repo = join(workspace, 'proj');
    await repository(repo); await edit(repo);
    for (const url of [`/api/git/changes?path=${encodeURIComponent(workspace)}`, `/api/git/changes/${encodeURIComponent(workspace)}`]) {
      const response = await f.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([{ status: 'UPDATED', path: 'proj/README.md' }, { status: 'ADDED', path: 'proj/notes.txt' }]);
    }
  } finally { await f.close(); }
});

it('returns empty changes for clean nested repos, plain paths, and broken markers only', async () => {
  const f = await fixture();
  try {
    const clean = join(f.root, 'clean'); await repository(join(clean, 'repo'));
    const plain = join(f.root, 'plain'); await mkdir(plain); await writeFile(join(plain, 'note.txt'), 'not versioned');
    const broken = join(f.root, 'broken'); await mkdir(join(broken, 'repo'), { recursive: true });
    await writeFile(join(broken, 'repo', '.git'), 'gitdir: /nonexistent-server05-fixture-git-directory\n');
    for (const target of [clean, plain, broken]) {
      const response = await f.changes(target); expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
    }
  } finally { await f.close(); }
});

it('maps a missing directory to source-compatible empty changes without changing path-query validation', async () => {
  const f = await fixture();
  try {
    for (const ref of [undefined, 'missing-ref']) {
      const response = await f.changes(join(f.root, 'not-created'), ref);
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual([]);
    }
    for (const url of ['/api/git/changes', '/api/git/changes?path=']) {
      expect((await f.app.inject({ method: 'GET', url })).statusCode).toBe(400);
    }
  } finally { await f.close(); }
});

it('skips a broken child but retains valid changes and rejects an invalid ref in a base repository', async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, 'workspace'); const repo = join(workspace, 'valid');
    await repository(repo); await edit(repo); await mkdir(join(workspace, 'broken'));
    await writeFile(join(workspace, 'broken', '.git'), 'gitdir: /nonexistent-server05-fixture-git-directory\n');
    const response = await f.changes(workspace, 'HEAD');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ status: 'UPDATED', path: 'valid/README.md' }, { status: 'ADDED', path: 'valid/notes.txt' }]);
    expect((await f.changes(repo, 'missing-ref')).statusCode).toBe(400);
  } finally { await f.close(); }
});

it('keeps root path ancestry correct and reports nested changes only once', async () => {
  const f = await fixture();
  try {
    const repo = join(f.root, 'repo'); await repository(repo); await repository(join(repo, 'foo')); await edit(join(repo, 'foo'));
    await mkdir(join(repo, 'foobar')); await writeFile(join(repo, 'foobar', 'file.py'), 'sibling');
    await writeFile(join(repo, 'foo-config.yaml'), 'sibling');
    const response = await f.changes(repo, 'HEAD'); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { status: 'ADDED', path: 'foo-config.yaml' }, { status: 'UPDATED', path: 'foo/README.md' },
      { status: 'ADDED', path: 'foo/notes.txt' }, { status: 'ADDED', path: 'foobar/file.py' },
    ]);
  } finally { await f.close(); }
});

it('discovers worktree gitdir files and immediate directory aliases', async () => {
  const f = await fixture();
  try {
    const repo = join(f.root, 'repo'); const workspace = join(f.root, 'workspace');
    await repository(repo); await mkdir(workspace);
    const worktree = join(workspace, 'linked'); await git(repo, 'worktree', 'add', '--detach', worktree, 'HEAD'); await edit(worktree);
    await symlink(worktree, join(workspace, 'alias'), 'dir');
    const response = await f.changes(workspace, 'HEAD'); expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { status: 'UPDATED', path: 'alias/README.md' }, { status: 'ADDED', path: 'alias/notes.txt' },
      { status: 'UPDATED', path: 'linked/README.md' }, { status: 'ADDED', path: 'linked/notes.txt' },
    ]);
  } finally { await f.close(); }
});

it('uses the SDK display base when ref is omitted and respects explicit HEAD', async () => {
  const f = await fixture();
  try {
    const workspace = join(f.root, 'workspace'); const repo = join(workspace, 'proj'); await repository(repo);
    await git(repo, 'checkout', '-qb', 'feature'); await writeFile(join(repo, 'committed.txt'), 'branch work');
    await git(repo, 'add', 'committed.txt'); await git(repo, 'commit', '-qm', 'feature work');
    expect((await f.changes(repo)).json()).toEqual([{ status: 'ADDED', path: 'committed.txt' }]);
    expect((await f.changes(workspace)).json()).toEqual([{ status: 'ADDED', path: 'proj/committed.txt' }]);
    expect((await f.changes(workspace, 'HEAD')).json()).toEqual([]);
  } finally { await f.close(); }
});

it('retains the existing filtered file-path and symlink alias extension', async () => {
  const f = await fixture();
  try {
    const repo = join(f.root, 'repo'); const alias = join(f.root, 'repo-alias'); await repository(repo); await edit(repo);
    await symlink(repo, alias, 'dir');
    const response = await f.changes(join(alias, 'README.md'), 'HEAD');
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual([{ status: 'UPDATED', path: 'README.md' }]);
    expect((await f.changes(join(alias, 'README.md'), 'missing-ref')).statusCode).toBe(400);
  } finally { await f.close(); }
});
