import type { FastifyInstance, FastifyReply } from 'fastify';
import { MetaProfileLimitExceeded, MetaProfileStoreTimeoutError } from '@smolpaws/openhands-agent';
import { metaProfileDetailResponseSchema, metaProfileListResponseSchema, metaProfileNameSchema, metaProfileSchema } from './models.js';
import { param, parseBody } from './routeUtils.js';
import type { ServerStateService } from './serverState.js';

export function registerMetaProfileRoutes(app: FastifyInstance, state: ServerStateService): void {
  app.get('/api/meta-profiles', async (_request, reply) => withStoreErrors(reply, async () =>
    metaProfileListResponseSchema.parse(await state.listMetaProfiles())));
  app.get('/api/meta-profiles/:name', async (request, reply) => {
    const name = metaProfileNameSchema.parse(param(request, 'name'));
    return withStoreErrors(reply, async () => metaProfileDetailResponseSchema.parse({ name, config: await state.getMetaProfile(name) }), name);
  });
  app.post('/api/meta-profiles/:name', async (request, reply) => {
    const name = metaProfileNameSchema.parse(param(request, 'name'));
    const profile = parseBody(metaProfileSchema, request.body);
    return withStoreErrors(reply, async () => {
      await state.saveMetaProfile(name, profile);
      reply.status(201);
      return { name, message: `Meta-profile '${name}' saved` };
    }, name);
  });
  app.delete('/api/meta-profiles/:name', async (request, reply) => {
    const name = metaProfileNameSchema.parse(param(request, 'name'));
    return withStoreErrors(reply, async () => {
      await state.deleteMetaProfile(name);
      return { name, message: `Meta-profile '${name}' deleted` };
    }, name);
  });
  app.post('/api/meta-profiles/:name/activate', async (request, reply) => {
    const name = metaProfileNameSchema.parse(param(request, 'name'));
    return withStoreErrors(reply, async () => {
      await state.activateMetaProfile(name);
      return { name, message: `Meta-profile '${name}' activated` };
    }, name);
  });
}

async function withStoreErrors<T>(reply: FastifyReply, operation: () => Promise<T>, name?: string): Promise<T | undefined> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MetaProfileStoreTimeoutError) reply.status(503).send({ detail: 'Meta-profile store is busy. Please retry.' });
    else if (error instanceof MetaProfileLimitExceeded) reply.status(409).send({ detail: 'Meta-profile limit reached (50). Delete a meta-profile before saving a new one.' });
    else if (name !== undefined && hasCode(error, 'ENOENT')) reply.status(404).send({ detail: `Meta-profile '${name}' not found` });
    // The SDK emits this sanitized message for invalid stored JSON/schema.
    else if (error instanceof Error && error.message.startsWith('Failed to load meta-profile ') && error.message.endsWith(': invalid JSON or meta-profile schema.')) reply.status(400).send({ detail: error.message });
    else reply.status(500).send({ detail: 'Failed to access meta-profile store' });
    return undefined;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
