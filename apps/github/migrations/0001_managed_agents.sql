-- Separate routing state; no agent-core conversation or personal state belongs here.
CREATE TABLE managed_runs (
  run_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
  state TEXT NOT NULL,
  source_json TEXT NOT NULL,
  body TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  issue_number INTEGER NOT NULL,
  route_signature TEXT NOT NULL,
  model TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  started_ms INTEGER,
  cancel_requested_ms INTEGER,
  next_ms INTEGER NOT NULL,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  target_sha TEXT,
  repo_name TEXT,
  input TEXT,
  result TEXT,
  resume_state TEXT,
  error_code TEXT,
  reservation_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX managed_due ON managed_runs(state, next_ms, lease_until);
CREATE INDEX managed_thread ON managed_runs(repository_id, issue_number, provider, state);
CREATE TABLE managed_dispatch_receipts (
  run_id TEXT PRIMARY KEY REFERENCES managed_runs(run_id),
  session_id TEXT NOT NULL UNIQUE
);

CREATE TABLE managed_budgets (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  reserved_cents INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE managed_scans (
  surface TEXT PRIMARY KEY,
  cursor_ms INTEGER NOT NULL,
  baseline_ms INTEGER NOT NULL,
  scan_ms INTEGER,
  reconcile_ms INTEGER NOT NULL DEFAULT 0,
  next_url TEXT,
  lease_owner TEXT,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE managed_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  until_ms INTEGER NOT NULL
);
CREATE TABLE managed_settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE managed_replies (
  run_id TEXT NOT NULL REFERENCES managed_runs(run_id),
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  comment_id INTEGER,
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(run_id, kind)
);
CREATE TABLE github_generated_comments (
  repository_id INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  PRIMARY KEY(repository_id, comment_id)
);

-- Legacy queue handoff only; no local runner execution or conversation state.
CREATE TABLE github_intake_receipts (
  identity TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL
);
CREATE INDEX github_pending_intake ON github_intake_receipts(state, lease_until);
