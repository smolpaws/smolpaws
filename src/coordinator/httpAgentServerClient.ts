/**
 * HTTP implementation of {@link AgentServerClient} against the new upstream-shaped agent-server
 * (`@smolpaws/openhands-agent-server`). Contract validated against that package's `openapi.json`,
 * `src/`, and `examples/local-endpoint-smoke.ts`.
 *
 * Endpoints used (auth via `X-Session-API-Key`):
 *   POST /api/conversations                              (ensure conversation; 409 = already exists)
 *   POST /api/conversations/:id/events   {role,content,run[,event_id]}
 *   POST /api/conversations/:id/run
 *   GET  /api/conversations/:id/events/search?page_id=&limit=&kind=&source=
 *
 * `event_id` on append is the ADR §8 idempotent-append delta. This client sends it when available and
 * reads back `{event_id, created}` if the server returns them; until the delta ships the server returns
 * only `{success:true}` and we fall back to the deterministic id with `created:true`.
 */
import type { AgentEvent, AgentServerClient } from './types.js';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpAgentServerClientOptions {
  baseUrl: string;
  sessionApiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: FetchLike;
  /** Extra fields for conversation creation (workspace, agent, tags, …). */
  createDefaults?: Record<string, unknown>;
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
  private readonly baseUrl: string;
  private readonly sessionApiKey?: string;
  private readonly doFetch: FetchLike;
  private readonly createDefaults: Record<string, unknown>;
  private readonly searchKind?: string;

  constructor(options: HttpAgentServerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.sessionApiKey = options.sessionApiKey;
    this.doFetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.createDefaults = options.createDefaults ?? {};
    this.searchKind = options.searchKind;
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (json) headers['content-type'] = 'application/json';
    if (this.sessionApiKey) headers['x-session-api-key'] = this.sessionApiKey;
    return headers;
  }

  async ensureConversation(conversationId: string): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ id: conversationId, ...this.createDefaults }),
    });
    // 200/201 = created or returned; 409 = already exists — both mean the conversation now exists.
    if (res.status === 409 || res.ok) return;
    await this.raise('ensureConversation', res);
  }

  async appendEvent(
    conversationId: string,
    event: { eventId: string; role: string; content: unknown; run: boolean },
  ): Promise<{ eventId: string; created: boolean }> {
    const res = await this.doFetch(
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
    const res = await this.doFetch(
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
    const res = await this.doFetch(
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
