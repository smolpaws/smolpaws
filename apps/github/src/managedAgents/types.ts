import type { Provider } from './mentions.js';
export type { Provider } from './mentions.js';

export type Surface = 'issue_comment' | 'pull_request_review_comment';
export type RunState = 'shadow' | 'suppressed' | 'accepted' | 'dispatching' | 'running'
  | 'result_ready' | 'publishing' | 'delivered' | 'dispatch_unknown' | 'delivery_unknown'
  | 'awaiting_action' | 'budget_paused' | 'failed' | 'canceled';
export interface Route {
  enabled: boolean;
  model: string | null;
  agent_id?: string | null;
  agent_version?: number;
  environment_id?: string | null;
  network_allowed_domains?: string[];
}
export interface ManagedConfig {
  enabled: boolean;
  mode: 'shadow' | 'active';
  repository: { id: number; full_name: string };
  poll: { enabled: boolean; activation_timestamp: string | null; overlap_seconds: number; per_page: number; max_pages_per_tick: number };
  routes: Record<Provider, Route>;
  limits: { max_concurrent_jobs: number; max_requests_per_day: number; watchdog_minutes: number;
    daily_admission_budget_usd: number; claude_session_budget_usd: number; reservation_per_job_usd?: number };
  lifecycle: { max_tick_seconds: number; provider_poll_interval_seconds: number };
  context: { max_request_bytes: number; max_context_bytes: number; max_context_comments: number };
  direct_intake: { enabled: boolean };
  publication: { comments_enabled: boolean; comment_writer: { id: number; login: string } };
}
export interface GithubSource {
  kind: 'github'; surface: Surface; sourceId: number;
  context?: string;
}
export interface DirectSource {
  kind: 'direct'; provider: Provider; clientRequestId: string; issueNumber: number; body: string;
}
export type Input = GithubSource | DirectSource;
export interface Run {
  run_id: string; source_key: string; digest: string; provider: Provider; state: RunState;
  source_json: string; body: string; repository_id: number; issue_number: number;
  route_signature: string; model: string; created_ms: number; updated_ms: number;
  started_ms: number | null; cancel_requested_ms: number | null; next_ms: number; lease_owner: string | null; lease_until: number;
  version: number; session_id: string | null; target_sha: string | null;
  repo_name: string | null; input: string | null; result: string | null;
  resume_state: RunState | null;
  error_code: string | null; reservation_cents: number;
}
export interface Status {
  runId: string; provider: Provider; state: RunState; assessedCommit: string | null;
  updatedAt: string; actionRequired: boolean; reason: string | null;
}
export interface Comment {
  id: number; body: string; user: { id: number; login: string };
  created_at: string; html_url: string; issue_url?: string; pull_request_url?: string;
  path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string; commit_id?: string;
}
export interface Repository { id: number; full_name: string; default_branch: string; private: boolean }
export interface Target { sha: string; issueNumber: number; title: string; context: string; isPr: boolean }
export interface GithubGateway {
  repository(): Promise<Repository>;
  source(surface: Surface, id: number): Promise<Comment | null>;
  target(issueNumber: number): Promise<Target>;
  page(surface: Surface, since: number, next?: string | null): Promise<{ comments: Comment[]; next: string | null }>;
  writerId(): Promise<number>;
  findReply(issueNumber: number, marker: string): Promise<number[]>;
  postReply(issueNumber: number, body: string): Promise<number>;
  editReply(commentId: number, body: string): Promise<number>;
}
export type Observation = { state: 'running' | 'awaiting_action' | 'budget_paused' | 'failed' | 'canceled'; reason?: string }
  | { state: 'completed'; text: string };
export interface ProviderAdapter {
  start(input: string, run: Run): Promise<string>;
  observe(sessionId: string): Promise<Observation>;
  cancel(sessionId: string): Promise<void>;
}

export class RouterError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
