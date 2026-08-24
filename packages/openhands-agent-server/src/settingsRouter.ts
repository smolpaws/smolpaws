import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { conversationSettingsSchema, openHandsAgentSettingsSchema } from '@smolpaws/openhands-agent';

import {
  mcpServerPatchSchema,
  mcpServerSchema,
  secretCreateRequestSchema,
  settingsUpdateRequestSchema,
} from './models.js';
import { parseBody, param } from './routeUtils.js';
import { McpServerAlreadyExistsError, type ServerStateService } from './serverState.js';

export function registerSettingsRoutes(app: FastifyInstance, state: ServerStateService): void {
  app.get('/api/settings/agent-schema', async () => ({ schema: z.toJSONSchema(openHandsAgentSettingsSchema) }));
  app.get('/api/settings/conversation-schema', async () => ({ schema: z.toJSONSchema(conversationSettingsSchema) }));
  app.get('/api/settings', async () => state.settings());
  app.patch('/api/settings', async (request) => state.updateSettings(parseBody(settingsUpdateRequestSchema, request.body)));

  app.post('/api/settings/mcp/:settings_key', async (request, reply) => {
    const key = param(request, 'settings_key');
    const server = parseBody(mcpServerSchema, request.body);
    try {
      reply.status(201);
      return await state.createMcpServer(key, server);
    } catch (error) {
      if (error instanceof McpServerAlreadyExistsError) {
        reply.status(409).send({ detail: error.message });
        return undefined;
      }
      throw error;
    }
  });
  app.patch('/api/settings/mcp/:settings_key', async (request) => state.patchMcpServer(param(request, 'settings_key'), parseBody(mcpServerPatchSchema, request.body)));
  app.delete('/api/settings/mcp/:settings_key', async (request) => state.deleteMcpServer(param(request, 'settings_key')));

  app.get('/api/settings/secrets', async () => ({ secrets: await state.listSecrets() }));
  app.put('/api/settings/secrets', async (request) => state.setSecret(...secretArgs(parseBody(secretCreateRequestSchema, request.body))));
  app.get('/api/settings/secrets/:name', async (request, reply) => {
    const item = await state.getSecretMetadata(param(request, 'name'));
    if (item === null) {
      reply.status(404).send({ detail: 'Secret not found' });
      return undefined;
    }
    return { ...item, value: '**********' };
  });
  app.delete('/api/settings/secrets/:name', async (request) => {
    await state.deleteSecret(param(request, 'name'));
    return { success: true };
  });
}

function secretArgs(body: { readonly name: string; readonly value: string }): [string, string] {
  return [body.name, body.value];
}
