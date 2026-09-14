/**
 * WhatsApp message ledger.
 *
 * The bridge keeps its own SQLite record of chats and messages (the channel's ledger, `messages.db`),
 * separate from the durable Message Relay store. The ledger answers "what arrived, in which chat, since
 * when", and holds the dispatch cursors that used to live in the repo-relative `data/router_state.json`.
 * The relay store answers "what work is owed and settled".
 *
 * Ordering: WhatsApp timestamps have one-second resolution and messages can arrive late (offline sync),
 * so a timestamp cursor silently loses any message that shares a second with an already-dispatched one.
 * The ledger therefore uses its own monotonic **ingestion sequence** (`messages.seq`, assigned by an
 * insert trigger and preserved on upsert) for cursors; the remote message id is the dedup key and the
 * remote timestamp is only presentation order. `seq` is an explicit column rather than the rowid so it
 * survives VACUUM and is assigned for any writer of the table.
 *
 * The schema is the legacy `src/db.ts` schema so an existing `~/.smolpaws/whatsapp/messages.db` keeps
 * working; the scheduled-task tables it already contains are left untouched for the scheduler.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { installWhatsAppProgress, initializeWhatsAppProgress, markWhatsAppMessages, pendingWhatsAppClause } from '../../../src/whatsapp-progress.js';

export interface LedgerMessage {
  /** Local monotonic ingestion sequence. Cursors are expressed in this. */
  seq: number;
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  media_path: string | null;
  media_type: string | null;
}

export interface StoreMessageInput {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  media?: { path: string; type: string } | undefined;
}

const MESSAGE_COLUMNS =
  'seq, id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, media_type';

export class WhatsAppLedger {
  readonly db: Database.Database;

  constructor(ledgerPath: string) {
    if (ledgerPath !== ':memory:') mkdirSync(path.dirname(ledgerPath), { recursive: true });
    this.db = new Database(ledgerPath);
    this.db.pragma('journal_mode = WAL');
    installWhatsAppProgress(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        media_path TEXT,
        media_type TEXT,
        PRIMARY KEY (id, chat_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
      CREATE TABLE IF NOT EXISTS relay_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    for (const column of ['sender_name TEXT', 'media_path TEXT', 'media_type TEXT', 'seq INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE messages ADD COLUMN ${column}`);
      } catch {
        // column already exists
      }
    }
    // Ingestion sequence: rows from before this column existed are numbered once in rowid order (their
    // insertion order); every later insert, from any writer, gets MAX(seq)+1 through the trigger.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
      UPDATE messages SET seq = rowid + (SELECT COALESCE(MAX(seq), 0) FROM messages) WHERE seq IS NULL;
      CREATE TRIGGER IF NOT EXISTS messages_assign_seq AFTER INSERT ON messages
        WHEN NEW.seq IS NULL
      BEGIN
        UPDATE messages SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages)
          WHERE rowid = NEW.rowid;
      END;
      CREATE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_jid, seq);
    `);
  }

  initializeProgress(statePath?: string): void { initializeWhatsAppProgress(this.db, statePath); }

  close(): void {
    this.db.close();
  }

  /** Record that a chat exists (for group discovery) without storing content. */
  touchChat(chatJid: string, timestamp: string, name?: string): void {
    if (name) {
      this.db
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
           ON CONFLICT(jid) DO UPDATE SET name = excluded.name,
             last_message_time = MAX(last_message_time, excluded.last_message_time)`,
        )
        .run(chatJid, name, timestamp);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           last_message_time = MAX(last_message_time, excluded.last_message_time)`,
      )
      .run(chatJid, chatJid, timestamp);
  }

  updateChatName(chatJid: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
      )
      .run(chatJid, name, new Date().toISOString());
  }

  /**
   * Store or update a message. A replayed message id updates the row in place and keeps its ingestion
   * sequence, so a duplicate upsert never re-dispatches; a genuinely new message always gets a higher
   * sequence than everything ingested before it.
   */
  storeMessage(input: StoreMessageInput): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, media_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, chat_jid) DO UPDATE SET
           sender = excluded.sender,
           sender_name = excluded.sender_name,
           content = excluded.content,
           timestamp = excluded.timestamp,
           is_from_me = excluded.is_from_me,
           media_path = COALESCE(excluded.media_path, messages.media_path),
           media_type = COALESCE(excluded.media_type, messages.media_type)`,
      )
      .run(
        input.id,
        input.chatJid,
        input.sender,
        input.senderName,
        input.content,
        input.timestamp,
        input.isFromMe ? 1 : 0,
        input.media?.path ?? null,
        input.media?.type ?? null,
      );
  }

  /**
   * Messages ingested after the sequence cursor in the given chats, excluding the cat's own outbound
   * messages (recognized by their `<assistant>: ` prefix, because the human shares the WhatsApp account).
   */
  getNewMessages(chatJids: readonly string[], afterSeq: number, assistantName: string): LedgerMessage[] {
    if (chatJids.length === 0) return [];
    const placeholders = chatJids.map(() => '?').join(',');
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE seq > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ? AND ${pendingWhatsAppClause('dispatched')}
         ORDER BY seq`,
      )
      .all(afterSeq, ...chatJids, `${assistantName}:%`) as LedgerMessage[];
  }

  getMessagesSince(chatJid: string, afterSeq: number, assistantName: string): LedgerMessage[] {
    return this.db
      .prepare(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages
         WHERE chat_jid = ? AND seq > ? AND content NOT LIKE ? AND ${pendingWhatsAppClause('seen')}
         ORDER BY seq`,
      )
      .all(chatJid, afterSeq, `${assistantName}:%`) as LedgerMessage[];
  }

  getState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM relay_state WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO relay_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  /**
   * Per-chat dispatch cursor: the highest ingestion sequence already handed to the relay for this chat.
   *
   * First use on a ledger that only has legacy timestamp cursors (`dispatch_cursor:<chat>` or the global
   * `dispatch_cursor` from the root process) converts them once: everything at or before the legacy
   * timestamp counts as dispatched, nothing else does. A ledger with no cursor at all starts at 0.
   */
  getDispatchSeq(chatJid: string): number {
    const stored = this.getState(`dispatch_seq:${chatJid}`);
    if (stored !== null) return Number.parseInt(stored, 10) || 0;
    const legacy = this.getState(`dispatch_cursor:${chatJid}`) ?? this.getState('dispatch_cursor');
    const seq = legacy === null ? 0 : this.maxSeqAtOrBefore(chatJid, legacy);
    this.setDispatchSeq(chatJid, seq);
    return seq;
  }

  setDispatchSeq(chatJid: string, seq: number): void {
    markWhatsAppMessages(this.db, this.db.prepare('SELECT id, chat_jid FROM messages WHERE chat_jid = ? AND seq <= ?').all(chatJid, seq) as LedgerMessage[], 'dispatched');
    if (seq >= this.peekDispatchSeq(chatJid)) this.setState(`dispatch_seq:${chatJid}`, String(seq));
  }

  /** Per-chat "last message the agent saw" so the next prompt carries only the new tail. */
  getLastAgentSeq(chatJid: string): number {
    const stored = this.getState(`last_agent_seq:${chatJid}`);
    if (stored !== null) return Number.parseInt(stored, 10) || 0;
    const legacy = this.getState(`last_agent_ts:${chatJid}`);
    const seq = legacy === null ? 0 : this.maxSeqAtOrBefore(chatJid, legacy);
    this.setState(`last_agent_seq:${chatJid}`, String(seq));
    return seq;
  }

  setLastAgentSeq(chatJid: string, seq: number): void {
    markWhatsAppMessages(this.db, this.db.prepare('SELECT id, chat_jid FROM messages WHERE chat_jid = ? AND seq <= ?').all(chatJid, seq) as LedgerMessage[], 'seen');
    this.setState(`last_agent_seq:${chatJid}`, String(seq));
  }

  private peekDispatchSeq(chatJid: string): number {
    return Number.parseInt(this.getState(`dispatch_seq:${chatJid}`) ?? '0', 10) || 0;
  }

  private maxSeqAtOrBefore(chatJid: string, timestamp: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE chat_jid = ? AND timestamp <= ?`)
      .get(chatJid, timestamp) as { seq: number };
    return row.seq;
  }
}
