/** Reconcile interrupted runs without replaying an unobserved tool side effect. */
import type Database from 'better-sqlite3';
import type { AgentEvent } from './types.js';
interface Progress { pending: boolean; actions: string[]; issue?: string }
export class RunRecovery {
  constructor(private readonly db: Database.Database) {
    db.exec('CREATE TABLE IF NOT EXISTS relay_runs (conversation_id TEXT PRIMARY KEY, value_json TEXT NOT NULL)');
  }
  observe(conversationId: string, event: AgentEvent): void {
    const row = this.db.prepare('SELECT value_json FROM relay_runs WHERE conversation_id=?').get(conversationId) as { value_json: string } | undefined;
    const value: Progress = row ? JSON.parse(row.value_json) : { pending: false, actions: [] };
    const message = event.llm_message as { role?: string; tool_calls?: unknown[] } | undefined;
    if (event.kind === 'MessageEvent' && message?.role === 'user') { value.pending = true; delete value.issue; }
    if (event.kind === 'PauseEvent') value.pending = false;
    if (event.kind === 'ActionEvent' && !value.actions.includes(event.id)) value.actions.push(event.id);
    if (event.kind === 'ObservationEvent') value.actions = value.actions.filter(id => id !== event.action_id);
    if (event.kind === 'ObservationEvent' && event.tool_name === 'finish' && !(event.observation as { is_error?: boolean } | undefined)?.is_error ||
        event.kind === 'MessageEvent' && message?.role === 'assistant' && !message.tool_calls?.length) value.pending = false;
    this.db.prepare('INSERT INTO relay_runs VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET value_json=excluded.value_json').run(conversationId, JSON.stringify(value));
  }
  pending(): { conversationId: string; actions: string[] }[] {
    const rows = this.db.prepare('SELECT * FROM relay_runs').all() as { conversation_id: string; value_json: string }[];
    return rows.flatMap(row => { const value = JSON.parse(row.value_json) as Progress;
      return value.pending && !value.issue ? [{ conversationId: row.conversation_id, actions: value.actions }] : []; });
  }
  park(conversationId: string, issue: string): void {
    this.db.prepare("UPDATE relay_runs SET value_json=json_set(value_json, '$.issue', ?) WHERE conversation_id=?").run(issue, conversationId);
  }
}
