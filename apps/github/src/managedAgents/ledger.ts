import { RouterError, type ManagedConfig, type Provider, type Run, type RunState } from './types.js';

const ACTIVE = "'dispatching','dispatch_unknown','running','awaiting_action','budget_paused'";
type Patch = Partial<Pick<Run, 'state' | 'next_ms' | 'lease_owner' | 'lease_until' | 'started_ms'
  | 'cancel_requested_ms'
  | 'session_id' | 'target_sha' | 'repo_name' | 'input' | 'result' | 'error_code' | 'resume_state'>>;
export interface Scan { surface: string; cursor_ms: number; baseline_ms: number; scan_ms: number | null; next_url: string | null; version: number }
export interface Reply { run_id: string; kind: string; body: string; digest: string; state: string; comment_id: number | null; lease_owner: string | null; lease_until: number }

export class Ledger {
  constructor(readonly db: D1Database, private now: () => number) {}
  async byKey(key: string): Promise<Run | null> {
    return this.db.prepare('SELECT * FROM managed_runs WHERE source_key=?').bind(key).first<Run>();
  }
  async get(id: string): Promise<Run | null> {
    return this.db.prepare('SELECT * FROM managed_runs WHERE run_id=?').bind(id).first<Run>();
  }
  async generated(repoId: number, id: number): Promise<boolean> {
    return !!await this.db.prepare('SELECT 1 FROM github_generated_comments WHERE repository_id=? AND comment_id=?').bind(repoId, id).first();
  }
  async baseline(configured: number | null): Promise<number> {
    await this.db.prepare("INSERT OR IGNORE INTO managed_settings(name,value) VALUES('baseline',?)").bind(configured ?? this.now()).run();
    if (configured !== null) await this.db.prepare("UPDATE managed_settings SET value=MAX(value,?) WHERE name='baseline'").bind(configured).run();
    return (await this.db.prepare("SELECT value FROM managed_settings WHERE name='baseline'").first<{ value: number }>())!.value;
  }
  async admit(data: { key: string; digest: string; provider: Provider; source: string; body: string; issue: number;
    route: string; model: string; state: RunState }, c: ManagedConfig): Promise<Run> {
    const existing = await this.byKey(data.key);
    if (existing) {
      if (data.key.startsWith('direct:') && existing.digest !== data.digest) throw new RouterError('idempotency_conflict', 409);
      return existing;
    }
    const now = this.now(), day = new Date(now).toISOString().slice(0, 10), id = crypto.randomUUID();
    const cents = Math.ceil((c.limits.reservation_per_job_usd ?? 5) * 100);
    await this.db.batch([
      this.db.prepare('INSERT OR IGNORE INTO managed_budgets(day) VALUES(?)').bind(day),
      this.db.prepare(`INSERT OR IGNORE INTO managed_runs
        (run_id,source_key,digest,provider,state,source_json,body,repository_id,issue_number,route_signature,
         model,created_ms,updated_ms,next_ms,reservation_cents,error_code)
        SELECT ?,?,?,?,CASE WHEN ?!='accepted' THEN ?
          WHEN requests<? AND reserved_cents+?<=? THEN 'accepted' ELSE 'budget_paused' END,
          ?,?,?,?,?,?,?,?, ?,CASE WHEN ?='accepted' AND requests<? AND reserved_cents+?<=? THEN ? ELSE 0 END,
          CASE WHEN ?='accepted' AND (requests>=? OR reserved_cents+?>?) THEN 'admission_budget' ELSE NULL END
        FROM managed_budgets WHERE day=?`).bind(
        id, data.key, data.digest, data.provider, data.state, data.state,
        c.limits.max_requests_per_day, cents, Math.floor(c.limits.daily_admission_budget_usd * 100),
        data.source, data.body, c.repository.id, data.issue, data.route, data.model, now, now, now,
        data.state, c.limits.max_requests_per_day, cents, Math.floor(c.limits.daily_admission_budget_usd * 100), cents,
        data.state, c.limits.max_requests_per_day, cents, Math.floor(c.limits.daily_admission_budget_usd * 100), day),
      this.db.prepare(`UPDATE managed_budgets SET requests=requests+1,reserved_cents=reserved_cents+?
        WHERE day=? AND EXISTS(SELECT 1 FROM managed_runs WHERE run_id=? AND state='accepted')`).bind(cents, day, id),
    ]);
    const run = await this.byKey(data.key);
    if (!run) throw new RouterError('admission_unavailable', 503);
    if (data.key.startsWith('direct:') && run.digest !== data.digest) throw new RouterError('idempotency_conflict', 409);
    return run;
  }
  async lock(name: string, owner: string): Promise<boolean> {
    await this.db.prepare(`INSERT INTO managed_locks(name,owner,until_ms) VALUES(?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms
      WHERE managed_locks.until_ms<=?`).bind(name, owner, this.now() + 90_000, this.now()).run();
    const row = await this.db.prepare('SELECT owner FROM managed_locks WHERE name=?').bind(name).first<{ owner: string }>();
    return row?.owner === owner;
  }
  async unlock(name: string, owner: string): Promise<void> {
    await this.db.prepare('DELETE FROM managed_locks WHERE name=? AND owner=?').bind(name, owner).run();
  }
  async scan(surface: string, baseline: number, owner: string): Promise<Scan> {
    await this.db.prepare('INSERT OR IGNORE INTO managed_scans(surface,cursor_ms,baseline_ms,reconcile_ms) VALUES(?,?,?,?)')
      .bind(surface, baseline, baseline, this.now()).run();
    // Daily bounded re-enumeration repairs observations that moved outside the overlap.
    // Never abandon a continuation already in progress.
    await this.db.prepare(`UPDATE managed_scans SET cursor_ms=baseline_ms,reconcile_ms=?
      WHERE surface=? AND next_url IS NULL AND reconcile_ms<=?`).bind(this.now(), surface, this.now() - 86_400_000).run();
    await this.db.prepare(`UPDATE managed_scans SET lease_owner=?,version=version+1,
      next_url=CASE WHEN baseline_ms<? THEN NULL ELSE next_url END,
      scan_ms=CASE WHEN baseline_ms<? THEN NULL ELSE scan_ms END,
      cursor_ms=MAX(cursor_ms,?),baseline_ms=MAX(baseline_ms,?) WHERE surface=?`)
      .bind(owner, baseline, baseline, baseline, baseline, surface).run();
    return (await this.db.prepare('SELECT * FROM managed_scans WHERE surface=?').bind(surface).first<Scan>())!;
  }
  async surfaceOrder(): Promise<string[]> {
    const row = await this.db.prepare(`INSERT INTO managed_settings(name,value) VALUES('surface_rotation',0)
      ON CONFLICT(name) DO UPDATE SET value=1-value RETURNING value`).first<{ value: number }>();
    return row?.value ? ['pull_request_review_comment', 'issue_comment'] : ['issue_comment', 'pull_request_review_comment'];
  }
  async saveScan(scan: Scan, owner: string, scanTime: number, next: string | null): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE managed_scans SET cursor_ms=CASE WHEN ? IS NULL THEN ? ELSE cursor_ms END,
      scan_ms=CASE WHEN ? IS NULL THEN NULL ELSE ? END,next_url=?,version=version+1
      WHERE surface=? AND lease_owner=? AND version=?`)
      .bind(next, scanTime, next, scanTime, next, scan.surface, owner, scan.version).run();
    if (!result.meta.changes) return false;
    scan.version++; scan.next_url = next; scan.scan_ms = next ? scanTime : null;
    if (!next) scan.cursor_ms = scanTime;
    return true;
  }
  async recover(): Promise<void> {
    const now = this.now();
    await this.db.prepare(`UPDATE managed_runs SET state='dispatch_unknown',error_code='dispatch_ack_missing',
      lease_owner=NULL,lease_until=0,version=version+1,updated_ms=?
      WHERE state='dispatching' AND lease_until<=?`).bind(now, now).run();
    await this.db.prepare(`UPDATE managed_runs SET state='running',session_id=(SELECT session_id FROM managed_dispatch_receipts d WHERE d.run_id=managed_runs.run_id),
      error_code=NULL,next_ms=?,updated_ms=?,version=version+1
      WHERE state='dispatch_unknown' AND EXISTS(SELECT 1 FROM managed_dispatch_receipts d WHERE d.run_id=managed_runs.run_id)`)
      .bind(now, now).run();
    await this.db.prepare(`UPDATE managed_replies SET state='unknown',lease_owner=NULL,lease_until=0
      WHERE state='posting' AND lease_until<=?`).bind(now).run();
    await this.db.prepare(`UPDATE managed_runs SET state='delivery_unknown',error_code='publication_ack_missing',
      lease_owner=NULL,lease_until=0,next_ms=?,updated_ms=?,version=version+1
      WHERE state='publishing' AND lease_until<=?`).bind(now, now, now).run();
  }
  async due(): Promise<Run[]> {
    return (await this.db.prepare(`SELECT * FROM managed_runs WHERE next_ms<=? AND lease_until<=?
      AND state IN ('accepted','running','awaiting_action','budget_paused','result_ready','delivery_unknown','failed','canceled')
      ORDER BY CASE WHEN session_id IS NOT NULL AND state IN ('running','awaiting_action','budget_paused','delivery_unknown') THEN 0
        WHEN state='result_ready' THEN 1 WHEN state='accepted' THEN 2 ELSE 3 END,
        next_ms,created_ms,run_id LIMIT 20`).bind(this.now(), this.now()).all<Run>()).results;
  }
  async claim(run: Run, owner: string, max: number): Promise<Run | null> {
    const capacity = run.state === 'accepted' ? `AND (SELECT COUNT(*) FROM managed_runs WHERE state IN (${ACTIVE})
      AND (session_id IS NOT NULL OR state IN ('dispatching','dispatch_unknown')))<?
      AND NOT EXISTS(SELECT 1 FROM managed_runs other WHERE other.repository_id=managed_runs.repository_id
        AND other.issue_number=managed_runs.issue_number AND other.provider=managed_runs.provider AND other.state IN (${ACTIVE})
        AND (other.session_id IS NOT NULL OR other.state IN ('dispatching','dispatch_unknown')))` : '';
    const args: (string | number)[] = [owner, this.now() + 90_000, run.state === 'accepted' ? 'dispatching' : run.state,
      this.now(), run.run_id, run.version, this.now()];
    if (capacity) args.push(max);
    const r = await this.db.prepare(`UPDATE managed_runs SET lease_owner=?,lease_until=?,state=?,version=version+1,updated_ms=?
      WHERE run_id=? AND version=? AND lease_until<=? ${capacity}`).bind(...args).run();
    return r.meta.changes ? this.get(run.run_id) : null;
  }
  async update(run: Run, patch: Patch): Promise<Run | null> {
    const fields = Object.keys(patch) as (keyof Patch)[];
    const r = await this.db.prepare(`UPDATE managed_runs SET ${fields.map(k => `${k}=?`).join(',')},updated_ms=?,version=version+1
      WHERE run_id=? AND lease_owner=? AND version=? AND lease_until>?`)
      .bind(...fields.map(k => patch[k] ?? null), this.now(), run.run_id, run.lease_owner, run.version, this.now()).run();
    return r.meta.changes ? this.get(run.run_id) : null;
  }
  async receipt(runId: string, sessionId: string): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO managed_dispatch_receipts(run_id,session_id) VALUES(?,?)').bind(runId, sessionId).run();
    const receipt = await this.db.prepare('SELECT session_id FROM managed_dispatch_receipts WHERE run_id=?').bind(runId).first<{ session_id: string }>();
    if (receipt?.session_id !== sessionId) throw new RouterError('session_receipt_conflict', 503);
  }
  async reply(run: Run, kind: string, body: string, hash: string): Promise<Reply> {
    const owns = 'EXISTS(SELECT 1 FROM managed_runs WHERE run_id=? AND lease_owner=? AND version=? AND lease_until>?)';
    await this.db.prepare(`INSERT OR IGNORE INTO managed_replies(run_id,kind,body,digest) SELECT ?,?,?,? WHERE ${owns}`)
      .bind(run.run_id, kind, body, hash, run.run_id, run.lease_owner, run.version, this.now()).run();
    if (kind === 'status') await this.db.prepare(`UPDATE managed_replies SET body=?,digest=?,state='pending'
      WHERE run_id=? AND kind='status' AND state='delivered' AND digest!=? AND ${owns}`)
      .bind(body, hash, run.run_id, hash, run.run_id, run.lease_owner, run.version, this.now()).run();
    const reply = await this.db.prepare('SELECT * FROM managed_replies WHERE run_id=? AND kind=?').bind(run.run_id, kind).first<Reply>();
    if (!reply) throw new RouterError('publication_lease_lost', 503);
    return reply;
  }
  async beginPost(run: Run, reply: Reply): Promise<boolean> {
    const r = await this.db.prepare(`UPDATE managed_replies SET state='posting',lease_owner=?,lease_until=?
      WHERE run_id=? AND kind=? AND digest=? AND state='pending' AND EXISTS(SELECT 1 FROM managed_runs WHERE run_id=? AND lease_owner=? AND version=? AND lease_until>?)`)
      .bind(run.lease_owner, run.lease_until, run.run_id, reply.kind, reply.digest, run.run_id, run.lease_owner, run.version, this.now()).run();
    return !!r.meta.changes;
  }
  async unknown(reply: Reply): Promise<void> {
    await this.db.prepare("UPDATE managed_replies SET state='unknown',lease_owner=NULL,lease_until=0 WHERE run_id=? AND kind=? AND digest=? AND state='posting'")
      .bind(reply.run_id, reply.kind, reply.digest).run();
  }
  async posted(run: Run, reply: Reply, id: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("UPDATE managed_replies SET state='delivered',comment_id=?,lease_owner=NULL,lease_until=0 WHERE run_id=? AND kind=? AND digest=?")
        .bind(id, run.run_id, reply.kind, reply.digest),
      this.db.prepare('INSERT OR IGNORE INTO github_generated_comments(repository_id,comment_id) VALUES(?,?)').bind(run.repository_id, id),
    ]);
  }
  async pendingAgain(reply: Reply): Promise<void> {
    await this.db.prepare("UPDATE managed_replies SET state='pending',lease_owner=NULL,lease_until=0 WHERE run_id=? AND kind=? AND digest=? AND state='posting'")
      .bind(reply.run_id, reply.kind, reply.digest).run();
  }
}
