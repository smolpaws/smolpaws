import { type GitProviderRepository, type GitProviderRepositoryPage } from '@smolpaws/openhands-agent';
import { PYTHON_DECIMAL_ZEROES, pythonCasefold } from './gitCasefold.js';

export interface GitRepositorySearchInput {
  provider: 'github' | 'gitlab' | 'bitbucket';
  query?: string | null | undefined;
  limit?: number | undefined;
  page_id?: string | null | undefined;
}
export interface GitProviderSearchOptions {
  resolveSecret: (name: string) => Promise<string | null>;
  fetch?: typeof fetch;
}
export class GitProviderAPIError extends Error {
  constructor(message = 'GitHub repository search failed', readonly statusCode = 502) { super(message); this.name = 'GitProviderAPIError'; }
}

/** Configured registry secrets only; URLs and credentials never come from query parameters. */
export async function searchProviderRepositories(input: GitRepositorySearchInput, options: GitProviderSearchOptions): Promise<GitProviderRepositoryPage> {
  if (input.provider !== 'github') throw new GitProviderAPIError('Repository discovery is not supported for this provider', 400);
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new GitProviderAPIError('Invalid repository limit', 422);
  let token: string | null = null;
  try {
    for (const name of ['github_token', 'GITHUB_TOKEN', 'GH_TOKEN', 'github']) {
      const candidate = await options.resolveSecret(name);
      if (candidate) { token = candidate; break; }
    }
  } catch { throw new GitProviderAPIError('Could not read configured repository credentials'); }
  if (token === null) return { items: [], next_page_id: null, missing_token: true };
  let [page, offset] = parseCursor(input.page_id);
  const query = input.query ? pythonCasefold(input.query) : null;
  const items: GitProviderRepository[] = [];
  let next: string | null = null;
  const visited = new Set<number>();
  while (items.length < limit) {
    if (visited.has(page)) throw new GitProviderAPIError('Invalid repository pagination response');
    visited.add(page);
    const result = await getPage(page, token, options.fetch ?? globalThis.fetch);
    let candidates = result.items;
    if (query !== null) candidates = candidates.filter(item => pythonCasefold(item.full_name).includes(query));
    candidates = candidates.slice(offset);
    const remaining = limit - items.length;
    items.push(...candidates.slice(0, remaining));
    next = result.next;
    if (candidates.length > remaining) return { items, next_page_id: `${page}:${offset + remaining}`, missing_token: false };
    if (query === null || next === null) break;
    [page, offset] = parseCursor(next);
  }
  return { items, next_page_id: next, missing_token: false };
}

function parseCursor(value?: string | null): [number, number] {
  if (value === undefined || value === null) return [1, 0];
  const parts = value.split(':');
  const page = parsePythonInteger(parts[0] ?? '');
  const offset = parts[1] === '' || parts.length === 1 ? 0 : parsePythonInteger(parts[1] ?? '');
  if (parts.length > 2 || page === null || offset === null || page < 1 || offset < 0) throw new GitProviderAPIError('Invalid repository page_id', 400);
  return [page, offset];
}

// Python int accepts Unicode decimal digits, signs and underscores between digits.
// Reject values outside JS's exact integer range instead of rounding cursor state.
function parsePythonInteger(raw: string): number | null {
  const normalized = Array.from(raw.trim(), char => {
    const code = char.codePointAt(0)!;
    const zero = PYTHON_DECIMAL_ZEROES.find(first => code >= first && code <= first + 9);
    return zero === undefined ? char : String(code - zero);
  }).join('');
  if (!/^[+-]?[0-9](?:_?[0-9])*$/.test(normalized)) return null;
  const value = Number(normalized.replaceAll('_', ''));
  return Number.isSafeInteger(value) ? value : null;
}

async function getPage(page: number, token: string, fetchImpl: typeof fetch): Promise<{ items: GitProviderRepository[]; next: string | null }> {
  const url = new URL('https://api.github.com/user/repos');
  url.search = new URLSearchParams({ per_page: '100', page: String(page), sort: 'pushed', affiliation: 'owner,collaborator,organization_member' }).toString();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new GitProviderAPIError('GitHub repository search timed out', 504)); controller.abort(); }, 15_000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual', headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
      } });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new GitProviderAPIError('GitHub repository search failed', [401, 403].includes(response.status) ? response.status : response.status >= 500 ? 502 : 400);
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) throw new GitProviderAPIError('Invalid GitHub repository response');
      return { items: payload.map(mapRepository), next: nextPage(response.headers.get('link')) };
    })()]);
  } catch (error) {
    if (error instanceof GitProviderAPIError) throw error;
    throw new GitProviderAPIError();
  } finally { clearTimeout(timer); }
}

function nextPage(link: string | null): string | null {
  if (link === null) return null;
  for (const match of link.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/g)) {
    if (match[2] !== 'next') continue;
    // Only page is consumed; never send a token to a provider-supplied link host.
    return new URL(match[1]!, 'https://api.github.com').searchParams.get('page') || null;
  }
  return null;
}

function mapRepository(value: unknown): GitProviderRepository {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GitProviderAPIError('Invalid GitHub repository response');
  const row = value as Record<string, unknown>;
  return {
    id: stringField(row.id), full_name: stringField(row.full_name), git_provider: 'github', is_public: !row.private,
    stargazers_count: typeof row.stargazers_count === 'number' && Number.isInteger(row.stargazers_count) ? row.stargazers_count : null,
    pushed_at: typeof row.pushed_at === 'string' ? row.pushed_at : null,
    main_branch: typeof row.default_branch === 'string' ? row.default_branch : null,
  };
}

function stringField(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'None';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  throw new GitProviderAPIError('Invalid GitHub repository response');
}
