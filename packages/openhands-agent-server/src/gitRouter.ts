import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GitProviderAPIError, searchProviderRepositories, type GitProviderSearchOptions } from './gitProviderService.js';

import { getCommitChanges, getCommitFileDiff, getGitChanges, getGitCommits, getGitDiff, isCommitSha } from './gitService.js';
import { param, queryRecord, stringQuery } from './routeUtils.js';

const MAX_COMMITS_LIMIT = 200;

const repositorySearchQuery = z.object({
  provider: z.enum(['github', 'gitlab', 'bitbucket']), query: z.string().optional(), page_id: z.string().optional(),
  limit: z.string().regex(/^[+]?\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
});

export function registerGitRoutes(app: FastifyInstance, providerOptions: GitProviderSearchOptions = { resolveSecret: async () => null }): void {
  app.get('/api/git/repositories/search', async (request, reply) => {
    const parsed = repositorySearchQuery.safeParse(queryRecord(request));
    if (!parsed.success) return reply.code(422).send({ detail: 'Invalid repository search query' });
    try { return await searchProviderRepositories(parsed.data, providerOptions); }
    catch (error) {
      if (error instanceof GitProviderAPIError) return reply.code(error.statusCode).send({ detail: error.message });
      return reply.code(502).send({ detail: 'Repository search failed' });
    }
  });
  app.get('/api/git/changes', async (request, reply) => handleGitRoute(reply, stringQuery(queryRecord(request).path), stringQuery(queryRecord(request).ref), getGitChanges));
  app.get('/api/git/diff', async (request, reply) => handleGitDiffQuery(reply, queryRecord(request)));
  app.get('/api/git/commits', async (request, reply) => handleGitCommitsRoute(reply, queryRecord(request)));
  app.get('/api/git/commits/:sha/changes', async (request, reply) => handleGitCommitChangesRoute(reply, param(request, 'sha'), queryRecord(request)));
  app.get('/api/git/changes/*', async (request, reply) => handleGitRoute(reply, param(request, '*'), stringQuery(queryRecord(request).ref), getGitChanges));
  app.get('/api/git/diff/*', async (request, reply) => handleGitRoute(reply, param(request, '*'), stringQuery(queryRecord(request).ref), getGitDiff));
}

async function handleGitDiffQuery(reply: ReplyLike, query: Record<string, unknown>): Promise<unknown> {
  const targetPath = stringQuery(query.path);
  const ref = stringQuery(query.ref);
  const commit = stringQuery(query.commit);
  if (ref !== null && commit !== null) {
    reply.status(400).send({ detail: "'ref' and 'commit' are mutually exclusive" });
    return undefined;
  }
  if (commit !== null) {
    if (targetPath === null || targetPath.trim().length === 0) {
      reply.status(400).send({ detail: 'path is required' });
      return undefined;
    }
    if (!isCommitSha(commit)) {
      reply.status(400).send({ detail: 'commit must be a hexadecimal SHA' });
      return undefined;
    }
    try {
      return await getCommitFileDiff(targetPath, commit);
    } catch (error) {
      reply.status(400).send({ detail: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }
  return handleGitRoute(reply, targetPath, ref, getGitDiff);
}

async function handleGitCommitsRoute(reply: ReplyLike, query: Record<string, unknown>): Promise<unknown> {
  const targetPath = stringQuery(query.path);
  if (targetPath === null || targetPath.trim().length === 0) {
    reply.status(400).send({ detail: 'path is required' });
    return undefined;
  }
  const rawLimit = query.limit;
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMMITS_LIMIT) {
    reply.status(422).send({ detail: `limit must be an integer between 1 and ${MAX_COMMITS_LIMIT}` });
    return undefined;
  }
  try {
    return await getGitCommits(targetPath, limit);
  } catch (error) {
    reply.status(400).send({ detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

async function handleGitCommitChangesRoute(reply: ReplyLike, sha: string, query: Record<string, unknown>): Promise<unknown> {
  const targetPath = stringQuery(query.path);
  if (!isCommitSha(sha)) {
    reply.status(400).send({ detail: 'commit must be a hexadecimal SHA' });
    return undefined;
  }
  if (targetPath === null || targetPath.trim().length === 0) {
    reply.status(400).send({ detail: 'path is required' });
    return undefined;
  }
  try {
    return await getCommitChanges(targetPath, sha);
  } catch (error) {
    reply.status(400).send({ detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

async function handleGitRoute<T>(
  reply: ReplyLike,
  targetPath: string | null,
  ref: string | null,
  operation: (targetPath: string, ref: string | null) => Promise<T>,
): Promise<T | undefined> {
  if (targetPath === null || targetPath.trim().length === 0) {
    reply.status(400).send({ detail: 'path is required' });
    return undefined;
  }
  try {
    return await operation(targetPath, ref);
  } catch (error) {
    reply.status(400).send({ detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

interface ReplyLike {
  status: (code: number) => { send: (payload: unknown) => void };
}
