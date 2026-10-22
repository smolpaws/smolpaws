/**
 * HTTP implementation of {@link AgentServerClient} against the new upstream-shaped agent-server
 * (`@smolpaws/openhands-agent-server`). Contract validated against that package's `openapi.json`,
 * `src/`, and `examples/local-endpoint-smoke.ts`.
 *
 * Endpoints used (auth via `X-Session-API-Key`):
 *   POST /api/conversations                              (ensure conversation; 409 = already exists)
 *   POST /api/conversations/:id/events   {role,content,run[,event_id]}
 *   POST /api/conversations/:id/run
 *   POST /api/conversations/:id/condense                 (one non-idempotent maintenance attempt)
 *   GET  /api/conversations/:id/events/search?page_id=&limit=&kind=&source=
 *
 * `event_id` on append is the ADR §8 idempotent-append delta. This client sends it when available and
 * reads back `{event_id, created}` if the server returns them; until the delta ships the server returns
 * only `{success:true}` and we fall back to the deterministic id with `created:true`.
 */
import { CONDENSE_REQUEST_TIMEOUT_MS } from './relayCommands.js';
import type { AgentEvent, AgentServerClient, LaneDescriptor } from './types.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpAgentServerClientOptions {
  conversationOwner?: string;
  requestTimeoutMs?: number;
  baseUrl: string;
  sessionApiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Extra fields for conversation creation (workspace, agent, tags, …). */
  createDefaults?: Record<string, unknown>;
  /** Per-lane creation fields merged over `createDefaults` (for example a per-scope workspace). */
  createDefaultsFor?: (lane: LaneDescriptor) => Record<string, unknown>;
  /** Restrict the projector's event search to a kind (e.g. 'ActionEvent'); omit for all kinds. */
  searchKind?: string;
}

export class HttpAgentServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** Non-retryable signals a permanent contract error (e.g. 4xx conflict) to the coordinator. */
    readonly nonRetryable: boolean,
  ) {
    super(message);
    this.name = 'HttpAgentServerError';
  }
}

export class HttpAgentServerClient implements AgentServerClient {
  private readonly conversationOwner: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly sessionApiKey?: string;
  private readonly doFetch: FetchLike;
  private readonly createDefaults: Record<string, unknown>;
  private readonly createDefaultsFor: ((lane: LaneDescriptor) => Record<string, unknown>) | undefined;
  private readonly searchKind?: string;

  constructor(options: HttpAgentServerClientOptions) {
    this.conversationOwner = options.conversationOwner;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sessionApiKey = options.sessionApiKey;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.createDefaults = options.createDefaults ?? {};
    this.createDefaultsFor = options.createDefaultsFor;
    this.searchKind = options.searchKind;
  }

  private async request(url: string, init?: RequestInit, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const callerSignal = init?.signal;
    // AbortSignal.any is unavailable on the earliest supported Node 20 releases.
    const forwardAbort = () => controller.abort(callerSignal?.reason);
    const timeout = setTimeout(() => controller.abort(new Error('Agent-server request timed out')), timeoutMs);
    try {
      if (callerSignal?.aborted) throw callerSignal.reason;
      callerSignal?.addEventListener('abort', forwardAbort, { once: true });
      const response = await this.doFetch(url, { ...init, signal: controller.signal });
      const body = await response.arrayBuffer();
      return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', forwardAbort);
    }
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.sessionApiKey) headers['x-session-api-key'] = this.sessionApiKey;
    return headers;
  }

  async ensureConversation(conversationId: string, lane?: LaneDescriptor): Promise<void> {
    const perLane = lane !== undefined && this.createDefaultsFor !== undefined ? this.createDefaultsFor(lane) : {};
    const res = await this.request(`${this.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ ...this.createDefaults, ...perLane, id: conversationId, ...(this.conversationOwner ? { tags: { ...((this.createDefaults.tags ?? {}) as object), ...((perLane.tags ?? {}) as object), smolpaws_relay_owner: this.conversationOwner } } : {}) }),
    });
    // 200/201 = created or returned; 409 = already exists — both mean the conversation now exists.
    if (res.status === 409 && this.conversationOwner) {
      const existing = await this.request(`${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`, { headers: this.headers(false) });
      if (!existing.ok) await this.raise('ensureConversation', existing);
      const info = await this.json(existing) as { tags?: Record<string, string> };
      if (info?.tags?.smolpaws_relay_owner !== this.conversationOwner) throw new HttpAgentServerError('Conversation belongs to another relay store; use isolated server persistence or reconcile the original store', 409, '', true);
      return;
    }
    if (res.status === 409 || res.ok) return;
    await this.raise('ensureConversation', res);
  }

  async executionStatus(conversationId: string): Promise<string> {
    const response = await this.request(`${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}`, { headers: this.headers(false) });
    if (!response.ok) await this.raise('executionStatus', response);
    return String(((await this.json(response)) as { execution_status: string }).execution_status).toLowerCase();
  }
  async resume(conversationId: string): Promise<void> {
    const response = await this.request(`${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/run`, { method: 'POST', headers: this.headers(true), body: '{}' });
    if (!response.ok) await this.raise('resume', response);
  }

  async condense(conversationId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/condense`, {
      method: 'POST', headers: this.headers(true), body: '{}', signal,
    }, CONDENSE_REQUEST_TIMEOUT_MS);
    if (!response.ok) await this.raise('condense', response);
    const result = await this.json(response) as { success?: unknown } | null;
    if (response.status !== 200 || result?.success !== true) throw new Error('Condensation outcome unconfirmed');
  }

  async appendEvent(
    conversationId: string,
    event: { eventId: string; role: string; content: unknown; run: boolean },
  ): Promise<{ eventId: string; created: boolean }> {
    const res = await this.request(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/events`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          event_id: event.eventId, // ignored by servers predating the ADR §8 delta
          role: event.role,
          content: event.content,
          run: event.run,
        }),
      },
    );
    if (!res.ok) await this.raise('appendEvent', res);
    const body = (await this.json(res)) as { event_id?: string; created?: boolean } | null;
    return {
      eventId: typeof body?.event_id === 'string' ? body.event_id : event.eventId,
      created: typeof body?.created === 'boolean' ? body.created : true,
    };
  }

  async searchEvents(
    conversationId: string,
    pageId: string | null,
    limit: number,
  ): Promise<{ items: AgentEvent[]; nextPageId: string | null }> {
    const params = new URLSearchParams();
    if (pageId !== null) params.set('page_id', pageId);
    params.set('limit', String(limit));
    if (this.searchKind) params.set('kind', this.searchKind);
    const res = await this.request(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/events/search?${params}`,
      { method: 'GET', headers: this.headers(false) },
    );
    if (!res.ok) await this.raise('searchEvents', res);
    const body = (await this.json(res)) as { items?: AgentEvent[]; next_page_id?: string | null } | null;
    return {
      items: Array.isArray(body?.items) ? body!.items : [],
      nextPageId: typeof body?.next_page_id === 'string' ? body!.next_page_id : null,
    };
  }

  /** Optional convenience: request a run (idempotent; 409 "already running" is not an error here). */
  async run(conversationId: string): Promise<void> {
    const res = await this.request(
      `${this.baseUrl}/api/conversations/${encodeURIComponent(conversationId)}/run`,
      { method: 'POST', headers: this.headers(true), body: '{}' },
    );
    if (res.status === 409 || res.ok) return;
    await this.raise('run', res);
  }

  private async json(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private async raise(op: string, res: Response): Promise<never> {
    const body = await res.text().catch(() => '');
    // 4xx (except 429) is a permanent contract error; 5xx / 429 / network are retryable.
    const nonRetryable = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw new HttpAgentServerError(`${op} failed: ${res.status}`, res.status, body, nonRetryable);
  }
}
