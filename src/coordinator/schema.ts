/**
 * SQLite schema for the Message Work Coordinator. See ./DESIGN.md §3.
 *
 * Applied idempotently on open. WAL + a busy timeout give multi-connection safety so a
 * `BEGIN IMMEDIATE` compare-and-set claim has exactly one winner (ADR crash-matrix: "two coordinator
 * processes claim together").
 */
import type Database from 'better-sqlite3';

const WORK_COLUMNS = [
  ['id', 'TEXT PRIMARY KEY'],
  ['kind', 'TEXT NOT NULL'],
  ['source_key', 'TEXT NOT NULL'],
  ['lane_key', 'TEXT NOT NULL'],
  ['sequence', 'INTEGER NOT NULL'],
  ['agent_event_id', 'TEXT'],
  ['state', 'TEXT NOT NULL'],
  ['available_at', 'TEXT NOT NULL'],
  ['claim_owner', 'TEXT'],
  ['claim_until', 'TEXT'],
  ['generation', 'INTEGER NOT NULL DEFAULT 0'],
  ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['send_attempted', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_error', 'TEXT'],
  ['external_message_id', 'TEXT'],
  ['payload_json', 'TEXT NOT NULL'],
  ['created_at', 'TEXT NOT NULL'],
  ['updated_at', 'TEXT NOT NULL'],
] as const;

const WORK_COLUMN_LIST = WORK_COLUMNS.map(([name]) => name).join(', ');

function createWorkTableSql(
  tableName: 'work' | 'work_with_lane_owner',
  ifNotExists: boolean,
): string {
  const columns = WORK_COLUMNS.map(([name, definition]) => `  ${name} ${definition}`).join(',\n');
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tableName} (\n${columns},\n  FOREIGN KEY (lane_key) REFERENCES lanes(lane_key)\n);`;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS lanes (
  lane_key           TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL,
  platform           TEXT NOT NULL,
  account_id         TEXT,
  chat_id            TEXT NOT NULL,
  thread_id          TEXT,
  display_name       TEXT,
  conversation_ready INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  last_seen_at       TEXT NOT NULL
);

${createWorkTableSql('work', true)}

-- Durable projector cursor per conversation: how far the delivery projector has consumed the EventLog.
-- Deliveries are inserted before the cursor advances, so a crash replays and the unique (kind, source_key)
-- index makes re-insertion a no-op (ADR crash matrix: projector dies before/after insert).
-- parked_at marks a cursor whose conversation the agent-server no longer has (a 404 on
-- events/search). A parked cursor is skipped by the projector so a permanently-absent
-- conversation cannot spin the outbound tick on 404s forever; it stays parked until reconciled.
CREATE TABLE IF NOT EXISTS projection_cursors (
  conversation_id TEXT PRIMARY KEY,
  next_page_id    TEXT,
  updated_at      TEXT NOT NULL,
  parked_at       TEXT
);
`;

const INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_lanes_conversation ON lanes (conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_kind_source ON work (kind, source_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_lane_seq ON work (lane_key, kind, sequence);
CREATE INDEX IF NOT EXISTS ix_work_claim ON work (state, available_at);
CREATE INDEX IF NOT EXISTS ix_work_lane ON work (lane_key, kind, sequence);
`;

export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  enforceLaneOwnership(db);
  migrateProjectionCursorsParkedAt(db);
}

function enforceLaneOwnership(db: Database.Database): void {
  db.transaction(() => {
    validateLaneOwnership(db);
    migrateWorkToLaneOwnership(db);
    db.exec(INDEX_SQL);
  }).immediate();
}

function validateLaneOwnership(db: Database.Database): void {
  const duplicate = db.prepare(
    `SELECT conversation_id, COUNT(*) AS count FROM lanes GROUP BY conversation_id HAVING COUNT(*) > 1 LIMIT 1`,
  ).get() as { conversation_id: string; count: number } | undefined;
  if (duplicate) throw new Error(`coordinator migration blocked: conversation '${duplicate.conversation_id}' is bound to ${duplicate.count} lanes`);
  const orphan = db.prepare(
    `SELECT w.id, w.lane_key FROM work w LEFT JOIN lanes l ON l.lane_key = w.lane_key WHERE l.lane_key IS NULL LIMIT 1`,
  ).get() as { id: string; lane_key: string } | undefined;
  if (orphan) throw new Error(`coordinator migration blocked: work '${orphan.id}' references unknown lane '${orphan.lane_key}'`);
  if (workColumns(db).has('conversation_id')) {
    const mismatch = db.prepare(
      `SELECT w.id FROM work w JOIN lanes l ON l.lane_key = w.lane_key WHERE w.conversation_id IS NOT l.conversation_id LIMIT 1`,
    ).get() as { id: string } | undefined;
    if (mismatch) throw new Error(`coordinator migration blocked: work '${mismatch.id}' disagrees with its lane conversation binding`);
  }
}

function workColumns(db: Database.Database): Set<string> {
  const columns = db.prepare(`PRAGMA table_info(work)`).all() as Array<{ name: string }>;
  return new Set(columns.map((column) => column.name));
}

function migrateWorkToLaneOwnership(db: Database.Database): void {
  const hasLegacyConversation = workColumns(db).has('conversation_id');
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(work)`).all() as Array<{ table: string; from: string; to: string }>;
  const hasLaneForeignKey = foreignKeys.some(
    (key) => key.table === 'lanes' && key.from === 'lane_key' && key.to === 'lane_key',
  );
  if (!hasLegacyConversation && hasLaneForeignKey) return;
  db.exec(createWorkTableSql('work_with_lane_owner', false));
  db.exec(`
    INSERT INTO work_with_lane_owner (${WORK_COLUMN_LIST})
    SELECT ${WORK_COLUMN_LIST} FROM work;
    DROP TABLE work;
    ALTER TABLE work_with_lane_owner RENAME TO work;
  `);
}

/** Idempotently add projection_cursors.parked_at to databases created before it existed. */
function migrateProjectionCursorsParkedAt(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(projection_cursors)`).all() as { name: string }[];
  if (!columns.some((column) => column.name === 'parked_at')) {
    db.exec(`ALTER TABLE projection_cursors ADD COLUMN parked_at TEXT`);
  }
}
