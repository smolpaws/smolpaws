import type { FastifyInstance } from 'fastify';

import { getGitChanges, getGitDiff } from './gitService.js';
import { param, queryRecord, stringQuery } from './routeUtils.js';

export function registerGitRoutes(app: FastifyInstance): void {
  app.get('/api/git/changes', async (request, reply) => handleGitRoute(reply, stringQuery(queryRecord(request).path), stringQuery(queryRecord(request).ref), getGitChanges));
  app.get('/api/git/diff', async (request, reply) => handleGitRoute(reply, stringQuery(queryRecord(request).path), stringQuery(queryRecord(request).ref), getGitDiff));
  app.get('/api/git/changes/*', async (request, reply) => handleGitRoute(reply, param(request, '*'), stringQuery(queryRecord(request).ref), getGitChanges));
  app.get('/api/git/diff/*', async (request, reply) => handleGitRoute(reply, param(request, '*'), stringQuery(queryRecord(request).ref), getGitDiff));
}

async function handleGitRoute<T>(
  reply: { status: (code: number) => { send: (payload: unknown) => void } },
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
