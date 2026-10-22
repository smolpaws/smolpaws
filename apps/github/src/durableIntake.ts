import type { SmolpawsQueueMessage } from '../../../src/shared/github.js';
import { boundedFetch, jsonResponse } from './managedAgents/http.js';

export interface IntakeEnv {
  GITHUB_DB?: D1Database;
  GITHUB_DURABLE_INTAKE_BASELINE?: string;
  GITHUB_USER_TOKEN?: string;
  SMOLPAWS_QUEUE: Queue<SmolpawsQueueMessage>;
}

export const isManagedRepository = (name?: string): boolean =>
  ['openhands/software-agent-sdk', 'openhands/agent-sdk'].includes(name?.toLowerCase() ?? '');

/** Existing Cache receipts remain a cutover input. D1 is authoritative after admission. */
export async function enqueueGithub(env: IntakeEnv, message: SmolpawsQueueMessage, identity?: string | null): Promise<void> {
  if (!env.GITHUB_DURABLE_INTAKE_BASELINE || !isManagedRepository(message.payload.repository?.full_name)) {
    await env.SMOLPAWS_QUEUE.send(message); return;
  }
  let baseline = Date.parse(env.GITHUB_DURABLE_INTAKE_BASELINE);
  if (!env.GITHUB_DB || !Number.isFinite(baseline) || !identity) throw new Error('Durable GitHub intake is not configured');
  await env.GITHUB_DB.prepare("INSERT INTO managed_settings(name,value) VALUES('legacy_baseline',?) ON CONFLICT(name) DO UPDATE SET value=MAX(value,excluded.value)").bind(baseline).run();
  baseline = (await env.GITHUB_DB.prepare("SELECT value FROM managed_settings WHERE name='legacy_baseline'").first<{ value: number }>())!.value;
  if (await env.GITHUB_DB.prepare('SELECT 1 FROM github_intake_receipts WHERE identity=?').bind(identity).first()) return;
  const repo = message.payload.repository!.full_name!;
  const path = message.event === 'issues' ? `issues/${message.payload.issue?.number}`
    : `${message.event === 'issue_comment' ? 'issues' : 'pulls'}/comments/${message.payload.comment?.id}`;
  const response = await boundedFetch(fetch)(`https://api.github.com/repos/${repo}/${path}`, { headers: {
    Accept: 'application/vnd.github+json', 'User-Agent': 'smolpaws-durable-intake',
    ...(env.GITHUB_USER_TOKEN ? { Authorization: `Bearer ${env.GITHUB_USER_TOKEN}` } : {}),
  } });
  if (response.status === 404) { await response.body?.cancel(); return; }
  const source = await jsonResponse<{ created_at: string }>(response);
  const created = Date.parse(source.created_at);
  if (!Number.isFinite(created)) throw new Error('GitHub source timestamp unavailable');
  // Explicit migration baseline prevents lookback replay when Cache receipts expire.
  if (created < baseline) return;
  await env.GITHUB_DB.prepare('INSERT OR IGNORE INTO github_intake_receipts(identity,payload,created_ms) VALUES(?,?,?)')
    .bind(identity, JSON.stringify({ ...message, delivery_id: identity }), Date.now()).run();
  await flushGithubIntake(env, identity);
}

export async function flushGithubIntake(env: IntakeEnv, identity?: string): Promise<void> {
  if (!env.GITHUB_DB || !env.GITHUB_DURABLE_INTAKE_BASELINE) return;
  const rows = (await env.GITHUB_DB.prepare(`SELECT identity,payload FROM github_intake_receipts
    WHERE state='pending' AND lease_until<=? ${identity ? 'AND identity=?' : ''} ORDER BY created_ms LIMIT 20`)
    .bind(Date.now(), ...(identity ? [identity] : [])).all<{ identity: string; payload: string }>()).results;
  for (const row of rows) {
    const owner = crypto.randomUUID(), now = Date.now();
    const claimed = await env.GITHUB_DB.prepare(`UPDATE github_intake_receipts SET lease_owner=?,lease_until=?
      WHERE identity=? AND state='pending' AND lease_until<=?`).bind(owner, now + 60_000, row.identity, now).run();
    if (!claimed.meta.changes) continue;
    try {
      await env.SMOLPAWS_QUEUE.send(JSON.parse(row.payload) as SmolpawsQueueMessage);
      await env.GITHUB_DB.prepare(`UPDATE github_intake_receipts SET state='enqueued',lease_owner=NULL,lease_until=0
        WHERE identity=? AND lease_owner=?`).bind(row.identity, owner).run();
    } catch {
      await env.GITHUB_DB.prepare('UPDATE github_intake_receipts SET lease_owner=NULL,lease_until=0 WHERE identity=? AND lease_owner=?')
        .bind(row.identity, owner).run();
      throw new Error('GitHub queue handoff pending');
    }
  }
}
