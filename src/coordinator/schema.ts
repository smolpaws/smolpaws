/**
 * SQLite schema for the Message Work Coordinator. See ./DESIGN.md §3.
 *
 * Applied idempotently on open. WAL + a busy timeout give multi-connection safety so a
 * `BEGIN IMMEDIATE` compare-and-set claim has exactly one winner (ADR crash-matrix: "two coordinator
 * processes claim together").
 */
import type Database from 'better-sqlite3';

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

CREATE TABLE IF NOT EXISTS work (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  source_key          TEXT NOT NULL,
  lane_key            TEXT NOT NULL,
  sequence            INTEGER NOT NULL,
  conversation_id     TEXT,
  agent_event_id      TEXT,
  state               TEXT NOT NULL,
  available_at        TEXT NOT NULL,
  claim_owner         TEXT,
  claim_until         TEXT,
  generation          INTEGER NOT NULL DEFAULT 0,
  attempts            INTEGER NOT NULL DEFAULT 0,
  send_attempted      INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  external_message_id TEXT,
  payload_json        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Idempotent accept: a duplicate platform input / projected delivery returns the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_kind_source ON work (kind, source_key);
-- Monotonic ordering per lane/kind.
CREATE UNIQUE INDEX IF NOT EXISTS ux_work_lane_seq ON work (lane_key, kind, sequence);
-- Claim scans and lane-head selection.
CREATE INDEX IF NOT EXISTS ix_work_claim ON work (state, available_at);
CREATE INDEX IF NOT EXISTS ix_work_lane ON work (lane_key, kind, sequence);

-- Durable projector cursor per conversation: how far the delivery projector has consumed the EventLog.
-- Deliveries are inserted before the cursor advances, so a crash replays and the unique (kind, source_key)
-- index makes re-insertion a no-op (ADR crash matrix: projector dies before/after insert).
CREATE TABLE IF NOT EXISTS projection_cursors (
  conversation_id TEXT PRIMARY KEY,
  next_page_id    TEXT,
  updated_at      TEXT NOT NULL
);
`;

export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
}
