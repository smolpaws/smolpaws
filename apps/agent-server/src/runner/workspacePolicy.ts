import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DaytonaEnv } from '../daytona.js';

export type RunnerEnv = DaytonaEnv & {
  SMOLPAWS_RUNNER_TOKEN?: string;
  RUNNER_PORT?: string;
  PORT?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  SMOLPAWS_WORKSPACE_ROOT?: string;
  SMOLPAWS_PERSISTENCE_DIR?: string;
};

export type AuthResult = {
  allowed: boolean;
  reason?: string;
};

const DEFAULT_PERSISTENCE_DIR = path.join(
  os.homedir(),
  '.openhands',
  'conversations',
);

export function getEnv(): RunnerEnv {
  return {
    SMOLPAWS_RUNNER_TOKEN: process.env.SMOLPAWS_RUNNER_TOKEN,
    RUNNER_PORT: process.env.RUNNER_PORT,
    PORT: process.env.PORT,
    LLM_MODEL: process.env.LLM_MODEL,
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_PROVIDER: process.env.LLM_PROVIDER,
    LLM_API_KEY: process.env.LLM_API_KEY,
    SMOLPAWS_WORKSPACE_ROOT: process.env.SMOLPAWS_WORKSPACE_ROOT,
    SMOLPAWS_PERSISTENCE_DIR: process.env.SMOLPAWS_PERSISTENCE_DIR,
    DAYTONA_API_KEY: process.env.DAYTONA_API_KEY,
    DAYTONA_API_URL: process.env.DAYTONA_API_URL,
    DAYTONA_TARGET: process.env.DAYTONA_TARGET,
    SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES:
      process.env.SMOLPAWS_DAYTONA_AUTO_STOP_MINUTES,
  };
}

export function resolvePersistenceDir(env: RunnerEnv): string {
  const raw =
    env.SMOLPAWS_PERSISTENCE_DIR ??
    process.env.OPENHANDS_CONVERSATIONS_DIR ??
    '';
  const value = raw.trim();
  if (!value) {
    return DEFAULT_PERSISTENCE_DIR;
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function normalizeHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function isAuthorized(
  request: { headers: Record<string, string | string[] | undefined> },
  env: RunnerEnv,
  options: { sessionApiKey?: string } = {},
): AuthResult {
  const token = env.SMOLPAWS_RUNNER_TOKEN;
  if (!token) {
    return { allowed: true };
  }

  const sessionApiKey =
    options.sessionApiKey ??
    normalizeHeader(request.headers['x-session-api-key']);
  if (sessionApiKey === token) {
    return { allowed: true };
  }

  const authorization = normalizeHeader(request.headers.authorization);
  if (!authorization) {
    return {
      allowed: false,
      reason: 'Missing Authorization or X-Session-API-Key header',
    };
  }
  const [scheme, value] = authorization.split(' ');
  if (scheme !== 'Bearer' || value !== token) {
    return { allowed: false, reason: 'Invalid Authorization token' };
  }
  return { allowed: true };
}

function isWithinResolvedRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export function getConfiguredWorkspaceRoot(env: RunnerEnv): string {
  const configuredRoot = env.SMOLPAWS_WORKSPACE_ROOT?.trim();
  return path.resolve(configuredRoot || process.cwd());
}

export function listAllowedWorkspaceRoots(env: RunnerEnv): string[] {
  return [getConfiguredWorkspaceRoot(env)];
}

export function resolveRequestedAbsolutePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error('Missing path');
  }
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return path.resolve(decodeURIComponent(withLeadingSlash));
}

export async function findNearestExistingPath(targetPath: string): Promise<string> {
  let currentPath = path.resolve(targetPath);
  while (true) {
    try {
      return await fs.realpath(currentPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(currentPath);
      if (parent === currentPath) {
        throw error;
      }
      currentPath = parent;
    }
  }
}

export async function isAllowedWorkspacePath(
  targetPath: string,
  env: RunnerEnv,
  mode: 'read' | 'write',
): Promise<boolean> {
  const roots = listAllowedWorkspaceRoots(env);
  if (!roots.length) {
    return false;
  }

  const canonicalTarget = mode === 'read'
    ? await fs.realpath(targetPath)
    : await findNearestExistingPath(targetPath);

  for (const root of roots) {
    const canonicalRoot = await fs.realpath(root).catch(() => path.resolve(root));
    if (isWithinResolvedRoot(canonicalTarget, canonicalRoot)) {
      return true;
    }
  }
  return false;
}

export function resolveWorkspaceRoot(
  requestedWorkingDir: string | undefined,
  env: RunnerEnv,
): string {
  const configuredRoot = getConfiguredWorkspaceRoot(env);
  if (typeof requestedWorkingDir !== 'string' || !requestedWorkingDir.trim()) {
    return configuredRoot;
  }
  const resolved = path.resolve(requestedWorkingDir.trim());
  if (!isWithinResolvedRoot(resolved, configuredRoot)) {
    throw new Error('workspace_root_not_allowed');
  }
  return resolved;
}

export function resolveAbsolutePersistenceRoot(
  persistenceDir: string,
  env: RunnerEnv,
): string {
  if (path.isAbsolute(persistenceDir)) {
    return persistenceDir;
  }
  return path.join(getConfiguredWorkspaceRoot(env), persistenceDir);
}
