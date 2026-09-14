/** Message-identity progress shared by the legacy host and standalone bridge during cutover. */
import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export type ProgressKind = 'dispatched' | 'seen';
export function installWhatsAppProgress(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_progress (
    id TEXT NOT NULL, chat_jid TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(id, chat_jid));
    CREATE TABLE IF NOT EXISTS whatsapp_progress_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

/** Import once, per message: MAX(seq) at a timestamp would skip holes from offline arrivals. */
export function initializeWhatsAppProgress(db: Database.Database, statePath?: string): void {
  installWhatsAppProgress(db);
  if (db.prepare("SELECT 1 FROM whatsapp_progress_meta WHERE key = 'initialized'").get()) return;
  const count = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const state = statePath && existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8')) as { last_timestamp?: string; last_agent_timestamp?: Record<string, string> }
    : undefined;
  const hasRelay = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'relay_state'").get();
  const relay = hasRelay ? db.prepare('SELECT value FROM relay_state WHERE key = ?') : undefined;
  const value = (key: string) => (relay?.get(key) as { value: string } | undefined)?.value;
  const hasCursor = hasRelay && !!db.prepare("SELECT 1 FROM relay_state WHERE key LIKE 'dispatch_%' OR key LIKE 'last_agent_%' LIMIT 1").get();
  if (count > 0 && (!state || typeof state !== 'object' || (!('last_timestamp' in state) && !('last_agent_timestamp' in state))) && !hasCursor) {
    throw new Error('Existing WhatsApp history needs its router_state.json before startup; set SMOLPAWS_WHATSAPP_ROUTER_STATE. Do not start at sequence zero.');
  }
  if (state !== undefined && state !== null && (typeof state !== 'object' || Array.isArray(state) || (state.last_timestamp !== undefined && typeof state.last_timestamp !== 'string') || (state.last_agent_timestamp !== undefined && (state.last_agent_timestamp === null || typeof state.last_agent_timestamp !== 'object' || Array.isArray(state.last_agent_timestamp) || Object.values(state.last_agent_timestamp).some(v => typeof v !== 'string'))))) {
    throw new Error('Invalid WhatsApp router_state.json');
  }
  const columns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  const hasSeq = columns.some(c => c.name === 'seq');
  const rows = db.prepare(`SELECT id, chat_jid, timestamp${hasSeq ? ', seq' : ''} FROM messages`).all() as { id: string; chat_jid: string; timestamp: string; seq?: number }[];
  db.transaction(() => {
    const insert = db.prepare('INSERT OR IGNORE INTO whatsapp_progress(id, chat_jid, dispatched, seen) VALUES (?, ?, ?, ?)');
    for (const row of rows) {
      const dispatchSeq = value(`dispatch_seq:${row.chat_jid}`);
      const seenSeq = value(`last_agent_seq:${row.chat_jid}`);
      const dispatchTime = value(`dispatch_cursor:${row.chat_jid}`) ?? value('dispatch_cursor') ?? state?.last_timestamp ?? '';
      const seenTime = value(`last_agent_ts:${row.chat_jid}`) ?? state?.last_agent_timestamp?.[row.chat_jid] ?? '';
      insert.run(row.id, row.chat_jid,
        Number(dispatchSeq !== undefined ? (row.seq ?? Infinity) <= Number(dispatchSeq) : row.timestamp <= dispatchTime),
        Number(seenSeq !== undefined ? (row.seq ?? Infinity) <= Number(seenSeq) : row.timestamp <= seenTime));
    }
    db.prepare("INSERT INTO whatsapp_progress_meta VALUES ('initialized', '1')").run();
    // Existing numeric cursors are represented by identity rows now; leave no max-sequence holes.
    if (hasRelay) db.prepare("DELETE FROM relay_state WHERE key LIKE 'dispatch_seq:%' OR key LIKE 'last_agent_seq:%' OR key LIKE 'dispatch_cursor%' OR key LIKE 'last_agent_ts:%'").run();
  })();
}

export function markWhatsAppMessages(db: Database.Database, messages: readonly { id: string; chat_jid: string }[], kind: ProgressKind): void {
  const stmt = db.prepare(`INSERT INTO whatsapp_progress(id, chat_jid, ${kind}) VALUES (?, ?, 1)
    ON CONFLICT(id, chat_jid) DO UPDATE SET ${kind} = 1`);
  db.transaction(() => { for (const message of messages) stmt.run(message.id, message.chat_jid); })();
}

export function pendingWhatsAppClause(kind: ProgressKind): string {
  return `NOT EXISTS (SELECT 1 FROM whatsapp_progress p WHERE p.id = messages.id AND p.chat_jid = messages.chat_jid AND p.${kind} = 1)`;
}


export function assertLegacyHandoff(db: Database.Database): void {
  const mode = db.prepare("SELECT value FROM whatsapp_progress_meta WHERE key = 'owner_mode'").get() as { value: string } | undefined;
  if (mode?.value === 'relay') throw new Error('Drain and stop the WhatsApp relay, then run npm run whatsapp:handoff -- legacy before starting the legacy host');
}

export function setWhatsAppOwnerMode(db: Database.Database, mode: 'relay' | 'legacy'): void {
  db.prepare("INSERT INTO whatsapp_progress_meta VALUES ('owner_mode', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
}
