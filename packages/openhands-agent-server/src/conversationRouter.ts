import type { FastifyInstance } from 'fastify';

import type { ConversationService } from './conversationService.js';
import {
  askAgentRequestSchema,
  conversationSortOrderSchema,
  forkConversationRequestSchema,
  startConversationRequestSchema,
  startGoalRequestSchema,
  updateConversationRequestSchema,
  updateSecretsRequestSchema,
  setConfirmationPolicyRequestSchema,
  setSecurityAnalyzerRequestSchema,
  type ConversationInfo,
  type StartConversationRequest,
} from './models.js';
import {
  acceptedDeviation,
  arrayQuery,
  booleanQuery,
  eventServiceOr404,
  intQuery,
  notImplemented,
  param,
  parseBody,
  queryRecord,
  stringArrayBody,
  stringQuery,
  successOrNotFound,
} from './routeUtils.js';

interface ConversationRouteOptions {
  readonly prepareStartRequest?: (input: unknown) => StartConversationRequest | Promise<StartConversationRequest>;
}

export function registerConversationRoutes(app: FastifyInstance, service: ConversationService, options: ConversationRouteOptions = {}): void {
  app.get('/api/conversations/search', async (request) => {
    const query = queryRecord(request);
    const includeSkills = booleanQuery(query.include_skills);
    const page = await service.searchConversations(
      stringQuery(query.page_id),
      intQuery(query.limit, 100),
      stringQuery(query.status),
      conversationSortOrderSchema.catch('CREATED_AT_DESC').parse(query.sort_order),
    );
    return {
      ...page,
      items: page.items.map((info) => conversationForResponse(info, includeSkills)),
    };
  });

  app.get('/api/conversations/count', async (request) => service.countConversations(stringQuery(queryRecord(request).status)));

  app.get('/api/conversations', async (request, reply) => {
    const query = queryRecord(request);
    const bodyIds = stringArrayBody(request.body);
    const ids = bodyIds.length > 0 ? bodyIds : arrayQuery(query.ids);
    if (ids.length === 0) {
      reply.status(422);
      return { detail: 'ids is required' };
    }
    if (ids.length >= 100) {
      reply.status(400);
      return { detail: 'ids must contain fewer than 100 items' };
    }
    const includeSkills = booleanQuery(query.include_skills);
    const conversations = await service.batchGetConversations(ids);
    return conversations.map((info) => info === null ? null : conversationForResponse(info, includeSkills));
  });

  app.post('/api/conversations', async (request, reply) => {
    const startRequest = options.prepareStartRequest === undefined
      ? parseBody(startConversationRequestSchema, request.body)
      : await options.prepareStartRequest(request.body);
    const result = await service.startConversation(startRequest);
    reply.status(result.isNew ? 201 : 200);
    return conversationForResponse(
      result.info,
      booleanQuery(queryRecord(request).include_skills),
    );
  });

  app.get('/api/conversations/:conversation_id', async (request, reply) => {
    const info = await service.getConversation(param(request, 'conversation_id'));
    if (info === null) {
      reply.status(404);
      return { detail: 'Conversation not found' };
    }
    return conversationForResponse(
      info,
      booleanQuery(queryRecord(request).include_skills),
    );
  });

  app.patch('/api/conversations/:conversation_id', async (request, reply) => {
    const updated = await service.updateConversation(param(request, 'conversation_id'), parseBody(updateConversationRequestSchema, request.body));
    return successOrNotFound(reply, updated);
  });

  app.delete('/api/conversations/:conversation_id', async (request, reply) => successOrNotFound(reply, await service.deleteConversation(param(request, 'conversation_id'))));

  app.get('/api/conversations/:conversation_id/agent_final_response', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    return { response: await eventService.getAgentFinalResponse() };
  });

  app.post('/api/conversations/:conversation_id/pause', async (request, reply) => successOrNotFound(reply, await service.pauseConversation(param(request, 'conversation_id'))));

  app.post('/api/conversations/:conversation_id/interrupt', async (request, reply) => successOrNotFound(reply, await service.interruptConversation(param(request, 'conversation_id'))));

  app.post('/api/conversations/:conversation_id/run', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    try {
      await eventService.run();
      return { success: true };
    } catch (error) {
      if (error instanceof Error && error.message === 'conversation_already_running') {
        reply.status(409);
        return { detail: 'Conversation already running. Wait for completion or pause first.' };
      }
      throw error;
    }
  });

  app.post('/api/conversations/:conversation_id/goal', async (request, reply) => {
    parseBody(startGoalRequestSchema, request.body);
    return notImplemented(reply, 'goal_loop_not_implemented');
  });
  app.post('/api/conversations/:conversation_id/goal/stop', async (_request, reply) => notImplemented(reply, 'goal_loop_not_implemented'));
  app.post('/api/conversations/:conversation_id/goal/resume', async (_request, reply) => notImplemented(reply, 'goal_loop_not_implemented'));

  app.post('/api/conversations/:conversation_id/secrets', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    const body = parseBody(updateSecretsRequestSchema, request.body);
    await eventService.updateSecrets(body.secrets);
    return { success: true };
  });

  app.post('/api/conversations/:conversation_id/confirmation_policy', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    parseBody(setConfirmationPolicyRequestSchema, request.body);
    return acceptedDeviation(reply, 'confirmation_policy');
  });

  app.post('/api/conversations/:conversation_id/security_analyzer', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    parseBody(setSecurityAnalyzerRequestSchema, request.body);
    return acceptedDeviation(reply, 'security_analyzer');
  });

  app.post('/api/conversations/:conversation_id/ask_agent', async (request, reply) => {
    parseBody(askAgentRequestSchema, request.body);
    return notImplemented(reply, 'ask_agent_not_implemented');
  });

  app.post('/api/conversations/:conversation_id/condense', async (_request, reply) => notImplemented(reply, 'condense_not_implemented'));

  app.post('/api/conversations/:conversation_id/fork', async (request, reply) => {
    const body = forkConversationRequestSchema.catch({ id: null, title: null, tags: null, reset_metrics: true }).parse(request.body ?? {});
    const forked = await service.forkConversation(param(request, 'conversation_id'), body);
    if (forked === null) {
      reply.status(404);
      return { detail: 'Source conversation not found' };
    }
    reply.status(201);
    return conversationForResponse(
      forked,
      booleanQuery(queryRecord(request).include_skills),
    );
  });
}

function conversationForResponse(info: ConversationInfo, includeSkills: boolean): ConversationInfo {
  if (includeSkills || !isRecord(info.agent)) return info;
  const agentContext = info.agent.agent_context;
  if (!isRecord(agentContext) || !Array.isArray(agentContext.skills) || agentContext.skills.length === 0) {
    return info;
  }

  return {
    ...info,
    agent: {
      ...info.agent,
      agent_context: {
        ...agentContext,
        skills: [],
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
