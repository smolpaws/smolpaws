import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Resolve only existing checkouts beneath the configured workspace root, including symlinks. */
export function githubWorkingDir(repository: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const expand = (value: string) => value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
  const requestedRoot = expand(env.SMOLPAWS_WORKSPACE_ROOT?.trim() || path.join(homedir(), 'repos'));
  if (!existsSync(requestedRoot)) return undefined;
  const root = realpathSync(requestedRoot);
  const mapPath = expand(env.SMOLPAWS_REPO_MAP_PATH?.trim() || path.join(env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws'), 'repo-map.json'));
  let mapped: string | undefined;
  if (existsSync(mapPath)) {
    const map: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Invalid repository workspace map');
    const value = Object.entries(map).find(([key]) => key.toLowerCase() === repository.toLowerCase())?.[1];
    if (value !== undefined && typeof value !== 'string') throw new Error('Invalid repository workspace mapping');
    mapped = value;
  }
  for (const candidate of [mapped, repository.split('/')[1]]) {
    if (!candidate) continue;
    const requested = path.resolve(root, expand(candidate));
    if (!existsSync(requested)) continue;
    const actual = realpathSync(requested);
    if (actual !== root && !actual.startsWith(`${root}${path.sep}`)) continue;
    if (statSync(actual).isDirectory()) return actual;
  }
  return undefined;
}
