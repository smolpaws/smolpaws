/** Shared product scheduler. Tools mutate one SQLite store; bridge workers submit due runs as relay intake. */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { deterministicConversationId, deterministicEventId } from './ids.js';
import type { AgentEvent, LaneDescriptor } from './types.js';

export function defaultSchedulerPath(): string {
  return process.env.SMOLPAWS_SCHEDULER_DB_PATH?.trim() || path.join(process.env.SMOLPAWS_HOME_DIR?.trim() || path.join(homedir(), '.smolpaws'), 'coordinator', 'scheduler.db');
}
export interface ScheduledLane {
  conversationId: string;
  lane: LaneDescriptor;
  scopeId: string;
  workingDir: string;
  relayDbPath: string;
  defaults: Record<string, unknown>;
}
export interface ScheduledTask {
  id: string; conversation_id: string; scope_id: string; prompt: string;
  schedule_type: 'cron' | 'interval' | 'once'; schedule_value: string;
  context_mode: 'group' | 'isolated'; next_run: string | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled'; last_run: string | null; last_result: string | null;
}
export interface ScheduledRun {
  id: string; task_id: string; conversation_id: string; source_id: string;
  status: string; scheduled_at: string; prompt: string; lane_json: string;
}
export type TaskResult = { text: string; is_error: boolean };

export class TaskScheduler {
  readonly db: Database.Database;
  constructor(dbPath = defaultSchedulerPath(), private readonly now = Date.now, private readonly timezone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone) {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_lanes (conversation_id TEXT PRIMARY KEY, platform TEXT NOT NULL, scope_id TEXT NOT NULL, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_tasks (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, scope_id TEXT NOT NULL,
        prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL, context_mode TEXT NOT NULL,
        next_run TEXT, status TEXT NOT NULL, last_run TEXT, last_result TEXT);
      CREATE TABLE IF NOT EXISTS scheduler_commands (id TEXT PRIMARY KEY, result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduler_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        source_id TEXT NOT NULL, status TEXT NOT NULL, scheduled_at TEXT NOT NULL, prompt TEXT NOT NULL, lane_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scheduler_due ON scheduler_tasks(status, next_run);
      CREATE INDEX IF NOT EXISTS scheduler_run_conversation ON scheduler_runs(conversation_id, status);
      CREATE TABLE IF NOT EXISTS scheduler_imports (source TEXT PRIMARY KEY);
    `);
  }
  close(): void { this.db.close(); }
  register(value: ScheduledLane): void {
    this.db.prepare(`INSERT INTO scheduler_lanes VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET
      platform=excluded.platform, scope_id=excluded.scope_id, value_json=excluded.value_json`).run(value.conversationId, value.lane.platform, value.scopeId, JSON.stringify(value));
  }
  lane(conversationId: string): ScheduledLane | null {
    const row = this.db.prepare('SELECT value_json FROM scheduler_lanes WHERE conversation_id = ?').get(conversationId) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as ScheduledLane : null;
  }
  private visible(scope: string, target: string): boolean { return scope === 'main' || scope === target; }
  private next(type: string, value: string): string {
    if (type === 'interval') {
      const ms = Number(value);
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('Interval must be a positive integer in milliseconds');
      return new Date(this.now() + ms).toISOString();
    }
    if (type === 'cron') return CronExpressionParser.parse(value, { tz: this.timezone, currentDate: new Date(this.now()) }).next().toISOString()!;
    if (type !== 'once' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid schedule timestamp');
    return new Date(value).toISOString();
  }
  execute(conversationId: string, kind: string, action: Record<string, unknown>, commandId: string): TaskResult {
    return this.db.transaction(() => {
      const key = `${conversationId}:${commandId}`;
      const previous = this.db.prepare('SELECT result_json FROM scheduler_commands WHERE id = ?').get(key) as { result_json: string } | undefined;
      if (previous) return JSON.parse(previous.result_json) as TaskResult;
      let result: TaskResult;
      try { result = { text: this.apply(conversationId, kind, action, key), is_error: false }; }
      catch (error) { result = { text: error instanceof Error ? error.message : String(error), is_error: true }; }
      this.db.prepare('INSERT INTO scheduler_commands VALUES (?, ?)').run(key, JSON.stringify(result));
      return result;
    })();
  }
  private apply(conversationId: string, kind: string, action: Record<string, unknown>, commandId: string): string {
    const source = this.lane(conversationId);
    if (!source) throw new Error('Conversation is not registered with the scheduler');
    if (kind === 'list_tasks') {
      const rows = this.db.prepare("SELECT * FROM scheduler_tasks WHERE status != 'cancelled' ORDER BY id").all() as ScheduledTask[];
      return JSON.stringify(rows.filter(task => this.visible(source.scopeId, task.scope_id)));
    }
    if (kind === 'schedule_task') {
      const scope = typeof action.target_group === 'string' ? action.target_group : source.scopeId;
      if (!this.visible(source.scopeId, scope)) throw new Error('Cannot schedule work for another scope');
      let target = source;
      if (scope !== source.scopeId) {
        const row = this.db.prepare("SELECT value_json FROM scheduler_lanes WHERE scope_id = ? AND value_json NOT LIKE '%:scheduled:%' ORDER BY conversation_id LIMIT 1").get(scope) as { value_json: string } | undefined;
        if (!row) throw new Error('Target scope is not registered');
        target = JSON.parse(row.value_json) as ScheduledLane;
      }
      if (typeof action.prompt !== 'string' || !action.prompt.trim()) throw new Error('Task prompt is required');
      const next = this.next(String(action.schedule_type), String(action.schedule_value));
      const id = `task-${deterministicConversationId(commandId)}`;
      this.db.prepare('INSERT INTO scheduler_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(id, target.conversationId, target.scopeId, action.prompt, String(action.schedule_type), String(action.schedule_value), action.context_mode === 'group' ? 'group' : 'isolated', next, 'active');
      return JSON.stringify({ task_id: id, next_run: next });
    }
    const task = this.db.prepare('SELECT * FROM scheduler_tasks WHERE id = ?').get(String(action.task_id)) as ScheduledTask | undefined;
    if (!task || task.status === 'cancelled' || !this.visible(source.scopeId, task.scope_id)) throw new Error('Task not found in this scope');
    if (kind === 'pause_task') { this.db.prepare("UPDATE scheduler_tasks SET status='paused' WHERE id=?").run(task.id); return 'Task paused'; }
    if (kind === 'cancel_task') {
      this.db.prepare("UPDATE scheduler_tasks SET status='cancelled', next_run=NULL WHERE id=?").run(task.id);
      this.db.prepare("UPDATE scheduler_runs SET status='cancelled' WHERE task_id=? AND status='ready'").run(task.id);
      return 'Task cancelled; an already submitted run is not revoked';
    }
    if (kind === 'resume_task') {
      const open = this.db.prepare("SELECT 1 FROM scheduler_runs WHERE task_id=? AND status IN ('ready','enqueued','started')").get(task.id);
      this.db.prepare("UPDATE scheduler_tasks SET status='active', next_run=? WHERE id=?").run(open ? null : this.next(task.schedule_type, task.schedule_value), task.id);
      return 'Task resumed';
    }
    if (kind === 'update_task') {
      const prompt = action.prompt === undefined ? task.prompt : String(action.prompt);
      if (!prompt.trim()) throw new Error('Task prompt is required');
      const type = action.schedule_type === undefined ? task.schedule_type : String(action.schedule_type);
      const value = action.schedule_value === undefined ? task.schedule_value : String(action.schedule_value);
      const next = this.next(type, value);
      const open = this.db.prepare("SELECT 1 FROM scheduler_runs WHERE task_id=? AND status IN ('ready','enqueued','started')").get(task.id);
      this.db.prepare('UPDATE scheduler_tasks SET prompt=?, schedule_type=?, schedule_value=?, next_run=? WHERE id=?').run(prompt, type, value, open ? null : next, task.id);
      return 'Task updated';
    }
    throw new Error('Unknown scheduler command');
  }
  /** Reserve one occurrence atomically. Retrying after a crash uses the same run and intake identity. */
  due(platform: string): ScheduledRun[] {
    this.db.transaction(() => {
      const tasks = this.db.prepare(`SELECT t.* FROM scheduler_tasks t JOIN scheduler_lanes l ON l.conversation_id=t.conversation_id
        WHERE l.platform=? AND t.status='active' AND t.next_run IS NOT NULL AND t.next_run<=?`).all(platform, new Date(this.now()).toISOString()) as ScheduledTask[];
      for (const task of tasks) {
        if (task.context_mode === 'group' && this.db.prepare("SELECT 1 FROM scheduler_runs WHERE conversation_id=? AND status IN ('ready','enqueued','started')").get(task.conversation_id)) continue;
        const origin = this.lane(task.conversation_id)!;
        const id = `${task.id}:${task.next_run}`;
        const { initial_message: _initialMessage, id: _id, ...defaults } = origin.defaults;
        const lane = task.context_mode === 'group' ? origin : {
          ...origin, defaults, conversationId: deterministicConversationId(id),
          lane: { ...origin.lane, laneKey: `${origin.lane.laneKey}:scheduled:${id}` },
        };
        this.register(lane);
        this.db.prepare('INSERT OR IGNORE INTO scheduler_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, task.id, lane.conversationId, `scheduled:${id}`, 'ready', task.next_run, task.prompt, JSON.stringify(lane));
        this.db.prepare('UPDATE scheduler_tasks SET next_run=NULL WHERE id=?').run(task.id);
      }
    })();
    return this.db.prepare(`SELECT r.* FROM scheduler_runs r JOIN scheduler_lanes l ON l.conversation_id=r.conversation_id
      JOIN scheduler_tasks t ON t.id=r.task_id WHERE l.platform=? AND r.status='ready' AND t.status='active' ORDER BY r.scheduled_at`).all(platform) as ScheduledRun[];
  }
  enqueued(id: string): void { this.db.prepare("UPDATE scheduler_runs SET status='enqueued' WHERE id=? AND status='ready'").run(id); }
  observe(conversationId: string, event: AgentEvent): void {
    const runs = this.db.prepare("SELECT * FROM scheduler_runs WHERE conversation_id=? AND status IN ('ready','enqueued','started')").all(conversationId) as ScheduledRun[];
    for (const run of runs) {
      const lane = JSON.parse(run.lane_json) as ScheduledLane;
      if (event.id === deterministicEventId(lane.lane.platform, run.source_id)) this.db.prepare("UPDATE scheduler_runs SET status='started' WHERE id=?").run(run.id);
      if (run.status !== 'started') continue;
      const message = event.llm_message as { role?: string; content?: { text?: string }[]; tool_calls?: unknown[] } | undefined;
      const terminal = event.kind === 'ObservationEvent' && event.tool_name === 'finish' || event.kind === 'MessageEvent' && message?.role === 'assistant' && !message.tool_calls?.length;
      const failed = event.kind === 'AgentErrorEvent' || event.kind === 'ConversationErrorEvent' || (terminal && (event.observation as { is_error?: boolean } | undefined)?.is_error === true);
      if (!terminal && !failed) continue;
      const observation = event.observation as { message?: string; text?: string } | undefined;
      const result = failed ? String(event.error ?? 'Run failed') : observation?.message ?? observation?.text ?? message?.content?.map(c => c.text ?? '').join('') ?? 'Completed';
      this.db.transaction(() => {
        this.db.prepare("UPDATE scheduler_runs SET status=? WHERE id=? AND status='started'").run(failed ? 'failed' : 'done', run.id);
        const task = this.db.prepare('SELECT * FROM scheduler_tasks WHERE id=?').get(run.task_id) as ScheduledTask;
        if (event.reconcile_required === true) task.status = 'paused';
        const recurring = task.schedule_type !== 'once';
        const next = recurring && task.status === 'active' ? this.next(task.schedule_type, task.schedule_value) : null;
        this.db.prepare('UPDATE scheduler_tasks SET next_run=?, last_run=?, last_result=?, status=? WHERE id=?').run(next, new Date(this.now()).toISOString(), result.slice(0, 200), !recurring && task.status === 'active' ? 'completed' : task.status, task.id);
      })();
    }
  }
  /** Offline reverse handoff. Repeatable: never resume an occurrence already in flight. */
  exportLegacy(ledger: Database.Database, sourcePath: string): void {
    const open = this.db.prepare("SELECT 1 FROM scheduler_runs r JOIN scheduler_lanes l ON l.conversation_id=r.conversation_id WHERE l.platform='whatsapp' AND r.status IN ('ready','enqueued','started')").get();
    if (open) throw new Error('Finish or reconcile scheduled WhatsApp runs before rollback');
    const tasks = this.db.prepare("SELECT t.* FROM scheduler_tasks t JOIN scheduler_lanes l ON l.conversation_id=t.conversation_id WHERE l.platform='whatsapp'").all() as ScheduledTask[];
    ledger.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated',
      next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL)`);
    ledger.transaction(() => {
      for (const task of tasks) {
        const lane = this.lane(task.conversation_id)!;
        if (task.status === 'cancelled') { ledger.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(task.id); continue; }
        ledger.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, last_run, last_result)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt, schedule_type=excluded.schedule_type,
          schedule_value=excluded.schedule_value, context_mode=excluded.context_mode, next_run=excluded.next_run, status=excluded.status,
          last_run=excluded.last_run, last_result=excluded.last_result`).run(task.id, task.scope_id, lane.lane.chatId, task.prompt, task.schedule_type, task.schedule_value,
          task.context_mode, task.next_run, task.status, new Date(this.now()).toISOString(), task.last_run, task.last_result);
      }
    })();
    this.db.prepare('DELETE FROM scheduler_imports WHERE source=?').run(sourcePath);
  }
  /** Import while the legacy socket/scheduler is stopped. Every source ledger is imported once. */
  importLegacy(ledger: Database.Database, sourcePath: string, lanes: readonly ScheduledLane[]): void {
    if (this.db.prepare('SELECT 1 FROM scheduler_imports WHERE source=?').get(sourcePath)) return;
    if (!ledger.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_tasks'").get()) return;
    const tasks = ledger.prepare('SELECT * FROM scheduled_tasks').all() as (ScheduledTask & { chat_jid: string; group_folder: string })[];
    this.db.transaction(() => {
      for (const lane of lanes) {
        const previous = this.db.prepare('SELECT id FROM scheduler_tasks WHERE conversation_id=?').all(lane.conversationId) as { id: string }[];
        for (const old of previous) if (!tasks.some(t => t.id === old.id)) this.db.prepare("UPDATE scheduler_tasks SET status='cancelled', next_run=NULL WHERE id=?").run(old.id);
      }
      for (const task of tasks) {
        const lane = lanes.find(l => l.lane.chatId === task.chat_jid && l.scopeId === task.group_folder);
        if (!lane) continue;
        this.register(lane);
        this.db.prepare(`INSERT INTO scheduler_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt, schedule_type=excluded.schedule_type, schedule_value=excluded.schedule_value, context_mode=excluded.context_mode, next_run=excluded.next_run, status=excluded.status, last_run=excluded.last_run, last_result=excluded.last_result`).run(task.id, lane.conversationId, lane.scopeId, task.prompt, task.schedule_type, task.schedule_value, task.context_mode || 'isolated', task.next_run, task.status, task.last_run, task.last_result);
      }
      // A canary allowlist is not a migration of tasks from excluded groups.
      if (tasks.every(t => lanes.some(l => l.lane.chatId === t.chat_jid))) this.db.prepare('INSERT INTO scheduler_imports VALUES (?)').run(sourcePath);
    })();
  }
}
