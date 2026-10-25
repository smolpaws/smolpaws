import { REPOSITORY_ID, WRITER_ID } from './config.js';
import { boundedFetch, boundedText, jsonResponse, mutation, MutationError } from './http.js';
import { RouterError, type Comment, type GithubGateway, type ManagedConfig, type Repository, type Surface, type Target } from './types.js';

const API = 'https://api.github.com';
export function nextPage(response: Response, path: string, relation = 'next'): string | null {
  for (const part of (response.headers.get('link') ?? '').split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] !== relation) continue;
    const url = new URL(match[1]);
    if (url.origin !== API || url.pathname !== path || url.username || url.password || url.hash) throw new RouterError('untrusted_pagination', 502);
    return url.href;
  }
  return null;
}
export function issueNumber(comment: Comment, repo: string): number {
  const url = new URL(comment.issue_url ?? comment.pull_request_url ?? 'https://invalid/');
  const match = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/);
  if (url.origin !== API || !match || match[1].toLowerCase() !== repo.toLowerCase()) throw new RouterError('source_destination_mismatch');
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number < 1) throw new RouterError('invalid_destination');
  return number;
}

export function createGithubGateway(config: ManagedConfig, token: string | undefined, fetchImpl: typeof fetch = fetch): GithubGateway {
  const send = boundedFetch(fetchImpl);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'smolpaws-managed-agents',
    'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let repositoryPromise: Promise<Repository> | undefined;
  async function read<T>(url: string): Promise<{ value: T; response: Response }> {
    const response = await send(url, { headers });
    return { value: await jsonResponse<T>(response), response };
  }
  async function repository(): Promise<Repository> {
    if (!repositoryPromise) repositoryPromise = (async () => {
      const { value: repo } = await read<Repository>(`${API}/repositories/${REPOSITORY_ID}`);
      if (repo.id !== REPOSITORY_ID || repo.private !== false || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)
        || typeof repo.default_branch !== 'string') throw new RouterError('repository_not_allowed', 403);
      return repo;
    })();
    return repositoryPromise;
  }
  async function comments(issue: number, limit: number): Promise<Comment[]> {
    if (!limit) return [];
    const repo = await repository(), path = `/repos/${repo.full_name}/issues/${issue}/comments`;
    const first = await read<Comment[]>(`${API}${path}?per_page=${limit}`);
    const lastUrl = nextPage(first.response, path, 'last');
    if (!lastUrl) return first.value.slice(-limit);
    const last = await read<Comment[]>(lastUrl);
    const previousUrl = nextPage(last.response, path, 'prev');
    const previous = last.value.length < limit && previousUrl
      ? (new URL(previousUrl).searchParams.get('page') === '1' ? first.value : (await read<Comment[]>(previousUrl)).value) : [];
    return [...previous, ...last.value].slice(-limit);
  }
  return {
    repository,
    async source(surface, id) {
      const repo = await repository(), kind = surface === 'issue_comment' ? 'issues' : 'pulls';
      const response = await send(`${API}/repos/${repo.full_name}/${kind}/comments/${id}`, { headers });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      const comment = await jsonResponse<Comment>(response);
      if (comment.id !== id || typeof comment.body !== 'string' || !Number.isSafeInteger(comment.user?.id)) throw new RouterError('invalid_source', 502);
      return comment;
    },
    async page(surface: Surface, since: number, next?: string | null) {
      const repo = await repository(), kind = surface === 'issue_comment' ? 'issues' : 'pulls';
      const path = `/repos/${repo.full_name}/${kind}/comments`;
      const url = next ? new URL(next) : new URL(`${API}${path}`);
      if (url.origin !== API || url.pathname !== path || url.username || url.password) throw new RouterError('untrusted_pagination', 502);
      if (!next) {
        url.searchParams.set('since', new Date(since).toISOString()); url.searchParams.set('sort', 'updated');
        url.searchParams.set('direction', 'asc'); url.searchParams.set('per_page', String(config.poll.per_page));
      }
      const { value, response } = await read<Comment[]>(url.href);
      if (!Array.isArray(value)) throw new RouterError('invalid_comment_page', 502);
      return { comments: value, next: nextPage(response, path) };
    },
    async target(number): Promise<Target> {
      if (!Number.isSafeInteger(number) || number < 1) throw new RouterError('invalid_destination');
      const repo = await repository();
      const { value: issue } = await read<{ title: string; body: string; user: { login: string }; pull_request?: unknown }>(`${API}/repos/${repo.full_name}/issues/${number}`);
      const isPr = !!issue.pull_request;
      const sha = isPr
        ? (await read<{ head: { sha: string } }>(`${API}/repos/${repo.full_name}/pulls/${number}`)).value.head?.sha
        : (await read<{ sha: string }>(`${API}/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`)).value.sha;
      if (typeof sha !== 'string' || !/^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(sha)) throw new RouterError('invalid_target_commit', 502);
      const discussion = await comments(number, config.context.max_context_comments);
      const context = JSON.stringify({ description: { author: issue.user?.login, body: issue.body },
        comments: discussion.map(c => ({ author: c.user?.login, source: c.html_url, body: c.body })) });
      return { issueNumber: number, sha, title: boundedText(issue.title ?? '', 500), isPr,
        context: boundedText(context, config.context.max_context_bytes) };
    },
    async writerId() {
      if (!token) throw new RouterError('writer_credential_missing', 503);
      return (await read<{ id: number }>(`${API}/user`)).value.id;
    },
    async findReply(issue, marker) {
      const repo = await repository(), path = `/repos/${repo.full_name}/issues/${issue}/comments`;
      let url: string | null = `${API}${path}?per_page=100`; const found: number[] = [];
      for (let page = 0; url && page < 20; page++) {
        const { value, response } = await read<Comment[]>(url);
        for (const c of value) if (c.user?.id === WRITER_ID && c.body?.includes(marker)) found.push(c.id);
        url = nextPage(response, path);
      }
      if (url) throw new RouterError('reconciliation_incomplete', 503);
      return found;
    },
    async postReply(issue, body) {
      if (!token) throw new RouterError('writer_credential_missing', 503);
      const repo = await repository();
      const result = await mutation<{ id: number; user: { id: number } }>(send,
        `${API}/repos/${repo.full_name}/issues/${issue}/comments`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
      if (!Number.isSafeInteger(result.id) || result.user?.id !== WRITER_ID) throw new MutationError(true);
      return result.id;
    },
    async editReply(id, body) {
      if (!token) throw new RouterError('writer_credential_missing', 503);
      const repo = await repository();
      const result = await mutation<{ id: number; user: { id: number } }>(send,
        `${API}/repos/${repo.full_name}/issues/comments/${id}`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
      if (result.id !== id || result.user?.id !== WRITER_ID) throw new MutationError(true);
      return id;
    },
  };
}
