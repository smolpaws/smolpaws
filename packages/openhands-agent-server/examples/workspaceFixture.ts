import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkspaceFixture {
  readonly directory: string;
  readonly initialHead: string;
  readonly originalReadme: string;
}

export async function createReadmeWorkspace(root: string, name: string, sourceReadme: string): Promise<WorkspaceFixture> {
  const directory = path.join(root, name);
  const originalReadme = await readFile(sourceReadme, 'utf8');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'README.md'), originalReadme, 'utf8');
  await git(directory, ['init', '-q']);
  await git(directory, ['config', 'user.name', 'Agent Server Profile Smoke']);
  await git(directory, ['config', 'user.email', 'profile-smoke@example.invalid']);
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-q', '-m', 'Add README fixture']);
  const initialHead = (await git(directory, ['rev-parse', 'HEAD'])).trim();
  return { directory, initialHead, originalReadme };
}

export async function gitOutput(directory: string, args: readonly string[]): Promise<string> {
  return git(directory, args);
}

async function git(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', directory, ...args]);
  return stdout;
}
