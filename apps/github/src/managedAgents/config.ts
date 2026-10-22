import { RouterError, type ManagedConfig, type Provider } from './types.js';

export const REPOSITORY_ID = 1043426082;
export const WRITER_ID = 255025612;
export const AUTHOR_IDS = new Set([6080905, WRITER_ID]);
export const POLICY_VERSION = '2026-10-22-v1';

export function parseConfig(text: string): ManagedConfig {
  let c: ManagedConfig;
  try { c = JSON.parse(text); } catch { throw new RouterError('invalid_configuration', 503); }
  const fail = (): never => { throw new RouterError('invalid_configuration', 503); };
  if (!c || typeof c.enabled !== 'boolean' || !['shadow', 'active'].includes(c.mode)) fail();
  if (c.repository?.id !== REPOSITORY_ID || !/^[\w.-]+\/[\w.-]+$/.test(c.repository.full_name)) fail();
  if (c.publication?.comment_writer?.id !== WRITER_ID || c.publication.comment_writer.login !== 'smolpaws') fail();
  if (typeof c.publication.comments_enabled !== 'boolean' || typeof c.direct_intake?.enabled !== 'boolean') fail();
  if (typeof c.poll?.enabled !== 'boolean') fail();
  const bounded = (n: unknown, min: number, max: number): void => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail();
  };
  bounded(c.poll?.overlap_seconds, 60, 3600);
  bounded(c.poll?.per_page, 1, 100);
  bounded(c.poll?.max_pages_per_tick, 1, 20);
  bounded(c.lifecycle?.max_tick_seconds, 1, 40);
  bounded(c.lifecycle?.provider_poll_interval_seconds, 60, 3600);
  bounded(c.limits?.max_concurrent_jobs, 1, 2);
  bounded(c.limits?.max_requests_per_day, 1, 20);
  bounded(c.limits?.watchdog_minutes, 1, 20);
  bounded(c.limits?.daily_admission_budget_usd, 0.01, 20);
  bounded(c.limits?.claude_session_budget_usd, 0.01, 5);
  bounded(c.limits?.reservation_per_job_usd ?? 5, 0.01, 20);
  bounded(c.context?.max_request_bytes, 1, 16384);
  bounded(c.context?.max_context_bytes, 1, 32768);
  bounded(c.context?.max_context_comments, 0, 20);
  for (const value of [c.poll.per_page, c.poll.max_pages_per_tick, c.poll.overlap_seconds,
    c.limits.max_concurrent_jobs, c.limits.max_requests_per_day, c.limits.watchdog_minutes,
    c.lifecycle.max_tick_seconds, c.lifecycle.provider_poll_interval_seconds,
    c.context.max_request_bytes, c.context.max_context_bytes, c.context.max_context_comments]) {
    if (!Number.isSafeInteger(value)) fail();
  }
  if (c.poll.activation_timestamp !== null && (typeof c.poll.activation_timestamp !== 'string' || !Number.isFinite(Date.parse(c.poll.activation_timestamp)))) fail();
  if (c.enabled && c.mode === 'active' && !c.poll.activation_timestamp) fail();
  for (const provider of ['codex', 'claude'] as Provider[]) {
    const r = c.routes?.[provider];
    if (!r || typeof r.enabled !== 'boolean') fail();
    if (r.model !== null && (typeof r.model !== 'string' || r.model.length > 120)) fail();
    if (c.enabled && c.mode === 'active' && r.enabled) {
      if (typeof r.model !== 'string' || !r.model.trim() || r.model.length > 120) fail();
      if (provider === 'claude' && (!r.agent_id || !r.environment_id || !Number.isInteger(r.agent_version) || r.agent_version! < 1)) fail();
    }
    if (r.network_allowed_domains !== undefined && (!Array.isArray(r.network_allowed_domains)
      || r.network_allowed_domains.length > 32
      || r.network_allowed_domains.some(d => typeof d !== 'string' || !/^[a-z\d.-]+$/i.test(d)))) fail();
  }
  return c;
}

export function routeSignature(c: ManagedConfig, provider: Provider): string {
  return JSON.stringify({ policy: POLICY_VERSION, route: c.routes[provider] });
}
