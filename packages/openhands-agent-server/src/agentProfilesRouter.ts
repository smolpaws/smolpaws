import { globalToolRegistry, validateAgentProfile, LaunchStoreError, type LaunchRuntime } from '@smolpaws/openhands-agent';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { agentProfilePayloadSchema, renameProfileRequestSchema } from './models.js';
import { param, parseBody } from './routeUtils.js';
import { AgentProfileLimitExceeded, InvalidStoredAgentProfile, type ServerStateService } from './serverState.js';
import { previewClient, previewServerProfile, type ServerLaunchOptions } from './launch.js';

export function registerAgentProfileRoutes(app: FastifyInstance, state: ServerStateService, options: {
  readonly runtime?: LaunchRuntime;
  readonly launchOptions?: ServerLaunchOptions;
} = {}): void {
  app.get('/api/agent-profiles', async () => state.listAgentProfiles());
  app.get('/api/agent-profiles/:name', async (request, reply) => {
    let profile;
    try { profile = await state.getAgentProfile(param(request, 'name')); }
    catch (error) {
      if (error instanceof InvalidStoredAgentProfile) return reply.status(400).send({ detail: error.message });
      throw error;
    }
    if (profile === null) {
      reply.status(404).send({ detail: 'Agent profile not found' });
      return undefined;
    }
    return profile;
  });
  app.post('/api/agent-profiles', async (request, reply) => {
    let payload;
    try { payload = validateAgentProfile(parseBody(agentProfilePayloadSchema, request.body)); }
    catch { return reply.status(422).send({ detail: 'Invalid agent profile' }); }
    let profile;
    try { profile = await state.saveAgentProfile(payload); }
    catch (error) {
      if (error instanceof AgentProfileLimitExceeded) return reply.status(409).send({ detail: error.message });
      throw error;
    }
    reply.status(201);
    return profile;
  });
  app.post('/api/agent-profiles/:name', async (request, reply) => {
    const name = param(request, 'name');
    let payload;
    try { payload = validateAgentProfile(parseBody(agentProfilePayloadSchema, { ...(isRecord(request.body) ? request.body : {}), name })); }
    catch { return reply.status(422).send({ detail: 'Invalid agent profile' }); }
    let profile;
    try { profile = await state.saveAgentProfile(payload); }
    catch (error) {
      if (error instanceof AgentProfileLimitExceeded) return reply.status(409).send({ detail: error.message });
      throw error;
    }
    reply.status(201);
    return profile;
  });
  app.delete('/api/agent-profiles/:name', async (request) => {
    const name = param(request, 'name');
    await state.deleteAgentProfile(name);
    return { name, message: `Agent profile '${name}' deleted` };
  });
  app.post('/api/agent-profiles/:name/rename', async (request, reply) => {
    const name = param(request, 'name');
    const { new_name: newName } = parseBody(renameProfileRequestSchema, request.body);
    try {
      await state.renameAgentProfile(name, newName);
    } catch (error) {
      reply.status(error instanceof Error && error.message === 'profile_exists' ? 409 : 404).send({ detail: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
    return { name: newName, message: name === newName ? `Agent profile '${name}' unchanged (same name)` : `Agent profile '${name}' renamed to '${newName}'` };
  });
  app.post('/api/agent-profiles/:profile_id/activate', async (request, reply) => {
    const profileId = param(request, 'profile_id');
    try {
      await state.activateAgentProfile(profileId);
    } catch {
      reply.status(404).send({ detail: 'Agent profile not found' });
      return undefined;
    }
    return { id: profileId, message: `Agent profile '${profileId}' activated` };
  });
  app.post('/api/agent-profiles/:name/materialize', async (request, reply) => {
    const parsed = z.object({ profile: z.record(z.string(), z.unknown()).nullable().optional() }).strict().safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(422).send({ detail: 'Materialize body must contain a wrapped profile draft' });
    const name = param(request, 'name');
    let profile;
    if (parsed.data.profile === null || parsed.data.profile === undefined) {
      try { profile = await state.getAgentProfile(name); }
      catch (error) {
        if (error instanceof InvalidStoredAgentProfile) return reply.status(400).send({ detail: error.message });
        const busy = error instanceof LaunchStoreError && error.retryable;
        return reply.status(busy ? 503 : 500).send({ detail: busy ? 'Profile store is busy. Please retry.' : 'Could not load agent profile' });
      }
    } else {
      try { profile = validateAgentProfile({ ...parsed.data.profile, name }); }
      catch { return reply.status(422).send({ detail: 'Invalid agent profile' }); }
    }
    if (profile === null) return reply.status(404).send({ detail: 'Agent profile not found' });
    return previewServerProfile(profile, state, options.runtime ?? {
      createClient: previewClient,
      isToolAvailable: tool => globalToolRegistry.isToolAvailable(tool),
    }, options.launchOptions);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
