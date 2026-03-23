import fsSync from 'node:fs';
import path from 'node:path';
import type { RunnerEnv } from '../runner/workspacePolicy.js';
import {
  getConfiguredWorkspaceRoot,
  getDefaultWorkingDir,
  resolveRepoMapPath,
  resolveWorkspaceRoot,
} from '../runner/workspacePolicy.js';
import type { SmolpawsConversationConfigValue } from '../shared/runner.js';

function isDirectory(dirPath: string): boolean {
  try {
    return fsSync.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function isWithinConfiguredRoot(targetPath: string, configuredRoot: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(configuredRoot);
  return normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function parseGithubRepoFullName(
  config?: SmolpawsConversationConfigValue,
): string | undefined {
  const fullName = config?.github?.repository_full_name?.trim();
  return fullName || undefined;
}

function parseGithubRepoName(
  config?: SmolpawsConversationConfigValue,
): string | undefined {
  const fullName = parseGithubRepoFullName(config);
  if (!fullName) {
    return undefined;
  }
  const repoName = fullName.substring(fullName.lastIndexOf('/') + 1).trim();
  return repoName || undefined;
}

function loadRepoMap(env: RunnerEnv): Map<string, string> {
  const repoMapPath = resolveRepoMapPath(env);
  if (!fsSync.existsSync(repoMapPath)) {
    return new Map();
  }

  try {
    const raw = fsSync.readFileSync(repoMapPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map();
    }

    const repoMap = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalizedKey = key.trim().toLowerCase();
      const normalizedValue = typeof value === 'string' ? value.trim() : '';
      if (!normalizedKey || !normalizedValue) {
        continue;
      }
      repoMap.set(normalizedKey, normalizedValue);
    }
    return repoMap;
  } catch (error) {
    console.warn(
      `[agent-server] Failed to read repo map: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Map();
  }
}

function resolveRepoMapCandidate(
  mapping: string,
  configuredRoot: string,
): string | undefined {
  const resolved = path.isAbsolute(mapping)
    ? path.resolve(mapping)
    : path.resolve(configuredRoot, mapping);
  if (!isWithinConfiguredRoot(resolved, configuredRoot)) {
    console.warn(
      `[agent-server] Ignoring repo map entry outside configured workspace root: ${mapping}`,
    );
    return undefined;
  }
  return isDirectory(resolved) ? resolved : undefined;
}

export function resolveGithubRepoWorkspaceRoot(params: {
  env: RunnerEnv;
  smolpawsConfig?: SmolpawsConversationConfigValue;
}): string | undefined {
  const configuredRoot = getConfiguredWorkspaceRoot(params.env);
  const repoFullName = parseGithubRepoFullName(params.smolpawsConfig);
  const repoName = parseGithubRepoName(params.smolpawsConfig);
  if (!repoFullName || !repoName) {
    return undefined;
  }

  const repoMap = loadRepoMap(params.env);
  const mapped = repoMap.get(repoFullName.toLowerCase());
  const candidates = [
    ...(mapped ? [resolveRepoMapCandidate(mapped, configuredRoot)] : []),
    resolveRepoMapCandidate(repoName, configuredRoot),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (isWithinConfiguredRoot(candidate, configuredRoot) && isDirectory(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function resolveConversationWorkspaceRoot(params: {
  requestedWorkingDir?: string;
  env: RunnerEnv;
  smolpawsConfig?: SmolpawsConversationConfigValue;
}): string {
  if (
    typeof params.requestedWorkingDir === 'string' &&
    params.requestedWorkingDir.trim()
  ) {
    return resolveWorkspaceRoot(params.requestedWorkingDir, params.env);
  }

  return (
    resolveGithubRepoWorkspaceRoot({
      env: params.env,
      smolpawsConfig: params.smolpawsConfig,
    }) ??
    getDefaultWorkingDir(params.env)
  );
}
