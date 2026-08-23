import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  getCommitChanges as getCommitChangesFromSdk,
  getCommitFileDiff as getCommitFileDiffFromSdk,
  getGitCommits as getGitCommitsFromSdk,
  GitRepositoryError,
  type GitChange as SdkGitChange,
} from '@smolpaws/openhands-agent';

import type { GitChange, GitCommitsPage, GitDiff } from './models.js';

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const SHA_PATTERN = /^[0-9a-fA-F]{4,64}$/u;

export function isCommitSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

export async function getGitCommits(targetPath: string, limit: number): Promise<GitCommitsPage> {
  try {
    const page = await getGitCommitsFromSdk(targetPath, limit);
    return { commits: [...page.commits], has_more: page.has_more };
  } catch (error: unknown) {
    if (error instanceof GitRepositoryError) return { commits: [], has_more: false };
    throw error;
  }
}

export async function getCommitChanges(targetPath: string, sha: string): Promise<GitChange[]> {
  try {
    return (await getCommitChangesFromSdk(targetPath, sha)).map(narrowGitChange);
  } catch (error: unknown) {
    if (error instanceof GitRepositoryError) return [];
    throw error;
  }
}

export async function getCommitFileDiff(targetPath: string, sha: string): Promise<GitDiff> {
  return getCommitFileDiffFromSdk(targetPath, sha).catch((error: unknown) => {
    if (error instanceof GitRepositoryError) return { modified: null, original: null };
    throw error;
  });
}

function narrowGitChange(change: SdkGitChange): GitChange {
  return { status: change.status === 'MOVED' ? 'UPDATED' : change.status, path: change.path };
}

export async function getGitChanges(targetPath: string, ref: string | null = null): Promise<GitChange[]> {
  const repoRoot = await resolveGitRepositoryRoot(targetPath).catch((error: Error) => {
    if (error.message === 'git_repository_not_found') return null;
    throw error;
  });
  if (repoRoot === null) return [];

  const relativePath = await relativeTarget(repoRoot, targetPath);
  const pathArgs = relativePath === '' ? [] : ['--', relativePath];
  const baseRef = ref ?? 'HEAD';
  const verifiedRef = await runCapturedCommand('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], repoRoot);
  let changes: GitChange[] = [];
  if (verifiedRef.exitCode === 0) {
    const result = await runCapturedCommand('git', ['--no-pager', 'diff', '--name-status', baseRef, ...pathArgs], repoRoot);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'git_changes_failed');
    changes = parseNameStatus(result.stdout);
  } else if (baseRef !== 'HEAD') {
    throw new Error(verifiedRef.stderr.trim() || `invalid_git_ref:${baseRef}`);
  }
  const untracked = await runCapturedCommand('git', ['--no-pager', 'ls-files', '--others', '--exclude-standard', ...pathArgs], repoRoot);
  if (untracked.exitCode === 0) {
    for (const line of untracked.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) changes.push({ status: 'ADDED', path: trimmed });
    }
  }
  return changes;
}

export async function getGitDiff(targetPath: string, ref: string | null = null): Promise<GitDiff> {
  const repoRoot = await resolveGitRepositoryRoot(targetPath).catch((error: Error) => {
    if (error.message === 'git_repository_not_found') return null;
    throw error;
  });
  if (repoRoot === null) return { modified: null, original: null };

  const relativePath = await relativeTarget(repoRoot, targetPath);
  const baseRef = ref ?? 'HEAD';
  const original = await runCapturedCommand('git', ['show', `${baseRef}:${relativePath}`], repoRoot);
  const modified = await fs.readFile(path.resolve(targetPath), 'utf8').catch(() => null);
  return {
    modified: modified === null ? null : normalizeNewlines(modified),
    original: original.exitCode === 0 ? normalizeNewlines(original.stdout) : null,
  };
}

async function resolveGitRepositoryRoot(targetPath: string): Promise<string> {
  const stats = await fs.stat(targetPath);
  const cwd = stats.isDirectory() ? targetPath : path.dirname(targetPath);
  const result = await runCapturedCommand('git', ['rev-parse', '--show-toplevel'], cwd);
  if (result.exitCode !== 0) throw new Error('git_repository_not_found');
  return canonicalPath(result.stdout.trim());
}

async function relativeTarget(repoRoot: string, targetPath: string): Promise<string> {
  const [canonicalRepoRoot, canonicalTarget] = await Promise.all([canonicalPath(repoRoot), canonicalPath(targetPath)]);
  const relative = path.relative(canonicalRepoRoot, canonicalTarget);
  if (relative === '.') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('git_target_outside_repository');
  }
  return relative;
}

async function canonicalPath(targetPath: string): Promise<string> {
  return fs.realpath(targetPath).catch(() => path.resolve(targetPath));
}

function parseNameStatus(stdout: string): GitChange[] {
  const changes: GitChange[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.replace(/\r$/u, '');
    if (trimmed.length === 0) continue;
    const parts = trimmed.split('\t');
    const status = parts[0] ?? '';
    if ((status.startsWith('R') || status.startsWith('C')) && parts.length >= 3) {
      const oldPath = parts[1] ?? '';
      const newPath = parts[2] ?? '';
      if (status.startsWith('R')) changes.push({ status: 'DELETED', path: oldPath });
      changes.push({ status: 'ADDED', path: newPath });
      continue;
    }
    const filePath = parts[1] ?? '';
    changes.push({ status: mapGitStatus(status), path: filePath });
  }
  return changes;
}

function mapGitStatus(status: string): GitChange['status'] {
  if (status === 'A' || status === '??') return 'ADDED';
  if (status === 'D') return 'DELETED';
  return 'UPDATED';
}

function normalizeNewlines(value: string): string {
  return value.split(/\r?\n/u).join('\n');
}

async function runCapturedCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : 1 }));
  });
}
