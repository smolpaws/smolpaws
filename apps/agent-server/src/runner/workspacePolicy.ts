import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RunnerEnv = {
  SMOLPAWS_RUNNER_TOKEN?: string;
  RUNNER_HOST?: string;
  HOST?: string;
  RUNNER_PORT?: string;
  PORT?: string;
  LLM_PROFILE_ID?: string;
  SMOLPAWS_WORKSPACE_ROOT?: string;
  SMOLPAWS_DEFAULT_WORKING_DIR?: string;
  SMOLPAWS_PERSISTENCE_DIR?: string;
  SMOLPAWS_VSCODE_SETTINGS_PATH?: string;
  SMOLPAWS_REPO_MAP_PATH?: string;
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
    RUNNER_HOST: process.env.RUNNER_HOST,
    HOST: process.env.HOST,
    RUNNER_PORT: process.env.RUNNER_PORT,
    PORT: process.env.PORT,
    LLM_PROFILE_ID: process.env.LLM_PROFILE_ID,
    SMOLPAWS_WORKSPACE_ROOT: process.env.SMOLPAWS_WORKSPACE_ROOT,
    SMOLPAWS_DEFAULT_WORKING_DIR: process.env.SMOLPAWS_DEFAULT_WORKING_DIR,
    SMOLPAWS_PERSISTENCE_DIR: process.env.SMOLPAWS_PERSISTENCE_DIR,
    SMOLPAWS_VSCODE_SETTINGS_PATH: process.env.SMOLPAWS_VSCODE_SETTINGS_PATH,
    SMOLPAWS_REPO_MAP_PATH: process.env.SMOLPAWS_REPO_MAP_PATH,
  };
}

function expandHomeDir(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function resolveVscodeSettingsPath(env: RunnerEnv): string {
  const configured = env.SMOLPAWS_VSCODE_SETTINGS_PATH?.trim();
  if (configured) {
    return path.resolve(expandHomeDir(configured));
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  }
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'settings.json');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json');
}

export function resolveRepoMapPath(env: RunnerEnv): string {
  const configured = env.SMOLPAWS_REPO_MAP_PATH?.trim();
  if (configured) {
    return path.resolve(expandHomeDir(configured));
  }
  return path.join(os.homedir(), '.smolpaws', 'repo-map.json');
}

export function getConfiguredLlmProfileId(env: RunnerEnv): string | undefined {
  const explicit = env.LLM_PROFILE_ID?.trim();
  if (explicit) {
    return explicit;
  }

  try {
    const settingsPath = resolveVscodeSettingsPath(env);
    if (!fsSync.existsSync(settingsPath)) {
      return undefined;
    }
    const raw = fsSync.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { ['openhands.llm.profileId']?: unknown };
    const profileId = typeof parsed['openhands.llm.profileId'] === 'string'
      ? parsed['openhands.llm.profileId'].trim()
      : '';
    return profileId || undefined;
  } catch (error) {
    console.warn(
      `[agent-server] Failed to read LLM profile from VS Code settings: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

export function resolveRunnerHost(env: RunnerEnv): string {
  const configuredHost = env.RUNNER_HOST?.trim() || env.HOST?.trim();
  return configuredHost || '127.0.0.1';
}

export function isLoopbackHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return normalizedHost === '127.0.0.1' ||
    normalizedHost === 'localhost' ||
    normalizedHost === '::1';
}

export function assertSafeRunnerBind(env: RunnerEnv): void {
  const host = resolveRunnerHost(env);
  if (!isLoopbackHost(host) && !env.SMOLPAWS_RUNNER_TOKEN?.trim()) {
    throw new Error('runner_token_required_for_non_localhost_bind');
  }
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

export function getDefaultWorkingDir(env: RunnerEnv): string {
  const configuredRoot = getConfiguredWorkspaceRoot(env);
  const configuredWorkingDir = env.SMOLPAWS_DEFAULT_WORKING_DIR?.trim();
  if (!configuredWorkingDir) {
    return configuredRoot;
  }
  const resolved = path.isAbsolute(configuredWorkingDir)
    ? path.resolve(configuredWorkingDir)
    : path.resolve(configuredRoot, configuredWorkingDir);
  if (!isWithinResolvedRoot(resolved, configuredRoot)) {
    throw new Error('default_working_dir_not_allowed');
  }
  return resolved;
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
    return getDefaultWorkingDir(env);
  }
  const normalized = requestedWorkingDir.trim();
  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(configuredRoot, normalized);
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
