import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_RUNNER_HOST = '127.0.0.1';
const DEFAULT_RUNNER_PORT = '8788';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

let startupPromise: Promise<void> | null = null;

function normalizeValue(value?: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function resolveRunnerBaseUrl(env = process.env): string {
  const explicit = normalizeValue(env.SMOLPAWS_RUNNER_URL);
  if (explicit) {
    const normalized = explicit.replace(/\/+$/, '');
    if (normalized.endsWith('/run')) {
      throw new Error(
        'SMOLPAWS_RUNNER_URL must be the agent-server base URL and must not end with /run',
      );
    }
    return normalized;
  }

  const host = normalizeValue(env.RUNNER_HOST) ?? DEFAULT_RUNNER_HOST;
  const port = normalizeValue(env.PORT) ?? DEFAULT_RUNNER_PORT;
  return `http://${host}:${port}`;
}

export function isLocalRunnerBaseUrl(baseUrl: string, env = process.env): boolean {
  if (normalizeValue(env.SMOLPAWS_RUNNER_URL)) {
    return false;
  }

  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function runnerReady(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL('/ready', baseUrl), { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

function startLocalRunnerProcess(): void {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(currentDir, '..', '..');
  const scriptPath = path.join(rootDir, 'scripts', 'run-local-agent-server.sh');

  spawn(scriptPath, {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();
}

export async function ensureLocalRunnerReady(
  fetchImpl: typeof fetch = fetch,
  env = process.env,
  startRunner: () => void = startLocalRunnerProcess,
): Promise<string> {
  const baseUrl = resolveRunnerBaseUrl(env);
  if (await runnerReady(baseUrl, fetchImpl)) {
    return baseUrl;
  }

  if (!isLocalRunnerBaseUrl(baseUrl, env)) {
    throw new Error(`Runner unavailable at ${baseUrl}`);
  }

  if (!startupPromise) {
    startupPromise = (async () => {
      startRunner();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await runnerReady(baseUrl, fetchImpl)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`Local runner did not become ready at ${baseUrl}`);
    })().finally(() => {
      startupPromise = null;
    });
  }

  await startupPromise;
  return baseUrl;
}
