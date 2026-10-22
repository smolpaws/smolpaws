import { parseConfig } from './config.js';
import { createGithubGateway } from './github.js';
import { boundedFetch } from './http.js';
import { createManagedRouter } from './index.js';
import { managedMentions } from './mentions.js';
import { claudeProvider } from './providers/claude.js';
import { openaiProvider } from './providers/openai.js';
import { RouterError, type Input, type ProviderAdapter, type Provider, type Surface } from './types.js';

export interface ManagedEnv {
  GITHUB_DB?: D1Database;
  MANAGED_AGENTS_CONFIG?: string;
  MANAGED_AGENTS_SERVICE_TOKEN?: string;
  MANAGED_OPENAI_API_KEY?: string;
  MANAGED_ANTHROPIC_API_KEY?: string;
  GITHUB_USER_TOKEN?: string;
}

function router(env: ManagedEnv, fetchImpl: typeof fetch = fetch) {
  if (!env.MANAGED_AGENTS_CONFIG || !env.GITHUB_DB) throw new RouterError('managed_routes_unconfigured', 503);
  const config = parseConfig(env.MANAGED_AGENTS_CONFIG);
  const request = boundedFetch(fetchImpl, AbortSignal.timeout(config.lifecycle.max_tick_seconds * 1000));
  const providers: Partial<Record<Provider, ProviderAdapter>> = {};
  if (env.MANAGED_OPENAI_API_KEY) providers.codex = openaiProvider(env.MANAGED_OPENAI_API_KEY, config.routes.codex, request);
  if (env.MANAGED_ANTHROPIC_API_KEY) providers.claude = claudeProvider(env.MANAGED_ANTHROPIC_API_KEY, config.routes.claude, config.limits.claude_session_budget_usd, request);
  return createManagedRouter({ db: env.GITHUB_DB, config,
    github: createGithubGateway(config, env.GITHUB_USER_TOKEN?.trim(), request), providers });
}

/** Reserve managed syntax before legacy actor/self filters, including when a route is disabled. */
export function managedIntent(env: ManagedEnv, body: string, repo?: string): boolean {
  return env.MANAGED_AGENTS_CONFIG !== undefined
    && ['openhands/software-agent-sdk', 'openhands/agent-sdk'].includes(repo?.toLowerCase() ?? '')
    && managedMentions(body).length > 0;
}

export async function acceptManagedComment(env: ManagedEnv, surface: Surface, sourceId: number) {
  try { return Response.json({ runs: await router(env).accept({ kind: 'github', surface, sourceId }) }, { status: 202 }); }
  catch (error) { return failure(error); }
}

function failure(error: unknown): Response {
  return Response.json({ error: error instanceof RouterError ? error.code : 'managed_service_unavailable' },
    { status: error instanceof RouterError ? error.status : 503 });
}

async function authenticated(request: Request, token?: string): Promise<boolean> {
  if (!token || token.length < 32) return false;
  const supplied = request.headers.get('Authorization') ?? '';
  const hash = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([hash(supplied), hash(`Bearer ${token}`)]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

export async function managedHttp(request: Request, env: ManagedEnv, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/managed-agents/')) return null;
  if (!await authenticated(request, env.MANAGED_AGENTS_SERVICE_TOKEN)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const service = router(env, fetchImpl);
    if (request.method === 'GET' && /^\/managed-agents\/runs\/[\w-]{1,128}$/.test(url.pathname)) {
      const status = await service.status(url.pathname.split('/').at(-1)!);
      return status ? Response.json(status) : Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (request.method !== 'POST' || url.pathname !== '/managed-agents/requests') return Response.json({ error: 'not_found' }, { status: 404 });
    // Bound bytes while streaming, before parsing any untrusted JSON.
    const reader = request.body?.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder();
    if (!reader) throw new RouterError('invalid_request');
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 24_000) { await reader.cancel(); throw new RouterError('request_too_large', 413); }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    let input: Record<string, unknown>;
    try { input = JSON.parse(text); } catch { throw new RouterError('invalid_request'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(k => !['provider', 'clientRequestId', 'repositoryId', 'issueNumber', 'body'].includes(k))
      || input.repositoryId !== 1043426082) throw new RouterError('invalid_request');
    const runs = await service.accept({ ...input, kind: 'direct' } as unknown as Input);
    return Response.json({ runs }, { status: 202 });
  } catch (error) { return failure(error); }
}

export async function tickManagedAgents(env: ManagedEnv): Promise<void> {
  if (!env.MANAGED_AGENTS_CONFIG) return;
  try { await router(env).tick(); }
  catch (error) { console.error('github.managed.tick_failed', { code: error instanceof RouterError ? error.code : 'unavailable' }); }
}
