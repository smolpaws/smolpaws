import { z } from 'zod';

import {
  agentResponseResultSchema,
  askAgentRequestSchema,
  askAgentResponseSchema,
  conversationInfoSchema,
  conversationPageSchema,
  forkConversationRequestSchema,
  healthStatusSchema,
  serverInfoSchema,
  setConfirmationPolicyRequestSchema,
  setSecurityAnalyzerRequestSchema,
  startGoalRequestSchema,
  successSchema,
  updateConversationRequestSchema,
  updateSecretsRequestSchema,
  confirmationResponseRequestSchema,
} from './models.js';

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

type Schema = z.ZodType<unknown>;

export interface RouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly requestBody?: Schema;
  readonly responses: Readonly<Record<number, Schema | null>>;
}

const openApiContentSchema = z.object({ type: z.string() }).passthrough();
const openApiSendMessageRequestSchema = z
  .object({
    role: z.enum(['user', 'system', 'assistant', 'tool']).default('user'),
    content: z.union([z.string(), z.array(openApiContentSchema)]),
    extended_content: z.array(openApiContentSchema).optional(),
    run: z.boolean().default(true),
    sender: z.string().nullable().optional(),
  })
  .strict();
const openApiStartConversationRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    agent: z.unknown().optional(),
    workspace: z.object({ kind: z.string().optional(), working_dir: z.string().optional() }).passthrough().optional(),
    initial_message: openApiSendMessageRequestSchema.optional(),
    persistence_dir: z.string().nullable().default('workspace/conversations'),
    max_iterations: z.number().int().positive().default(500),
    stuck_detection: z.boolean().default(true),
    title: z.string().nullable().optional(),
    tags: z.record(z.string(), z.string()).default({}),
    worktree: z.boolean().default(false),
  })
  .passthrough();
const openApiEventSchema = z.object({ kind: z.string() }).passthrough();
const openApiEventPageSchema = z.object({ items: z.array(openApiEventSchema), next_page_id: z.string().nullable().default(null) }).strict();
const eventBatchSchema = z.array(openApiEventSchema.nullable());
const conversationBatchSchema = z.array(conversationInfoSchema.nullable());

export const routeSpecs = [
  { method: 'get', path: '/', tags: ['Server Details'], summary: 'Server info root', responses: { 200: serverInfoSchema } },
  { method: 'get', path: '/alive', tags: ['Server Details'], summary: 'Liveness check', responses: { 200: healthStatusSchema } },
  { method: 'get', path: '/health', tags: ['Server Details'], summary: 'Health check', responses: { 200: healthStatusSchema } },
  { method: 'get', path: '/ready', tags: ['Server Details'], summary: 'Readiness check', responses: { 200: healthStatusSchema, 503: healthStatusSchema } },
  { method: 'get', path: '/server_info', tags: ['Server Details'], summary: 'Server information', responses: { 200: serverInfoSchema } },

  { method: 'get', path: '/api/conversations/search', tags: ['Conversations'], summary: 'Search conversations', responses: { 200: conversationPageSchema } },
  { method: 'get', path: '/api/conversations/count', tags: ['Conversations'], summary: 'Count conversations', responses: { 200: z.number().int().nonnegative() } },
  { method: 'get', path: '/api/conversations', tags: ['Conversations'], summary: 'Batch get conversations', responses: { 200: conversationBatchSchema } },
  { method: 'post', path: '/api/conversations', tags: ['Conversations'], summary: 'Start conversation', requestBody: openApiStartConversationRequestSchema, responses: { 200: conversationInfoSchema, 201: conversationInfoSchema } },
  { method: 'get', path: '/api/conversations/{conversation_id}', tags: ['Conversations'], summary: 'Get conversation', responses: { 200: conversationInfoSchema, 404: null } },
  { method: 'patch', path: '/api/conversations/{conversation_id}', tags: ['Conversations'], summary: 'Update conversation metadata', requestBody: updateConversationRequestSchema, responses: { 200: successSchema, 404: null } },
  { method: 'delete', path: '/api/conversations/{conversation_id}', tags: ['Conversations'], summary: 'Delete conversation', responses: { 200: successSchema, 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/agent_final_response', tags: ['Conversations'], summary: 'Get final agent response', responses: { 200: agentResponseResultSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/pause', tags: ['Conversations'], summary: 'Pause conversation', responses: { 200: successSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/interrupt', tags: ['Conversations'], summary: 'Interrupt conversation', responses: { 200: successSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/run', tags: ['Conversations'], summary: 'Run conversation', responses: { 200: successSchema, 404: null, 409: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/goal', tags: ['Conversations'], summary: 'Start goal loop', requestBody: startGoalRequestSchema, responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/goal/stop', tags: ['Conversations'], summary: 'Stop goal loop', responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/goal/resume', tags: ['Conversations'], summary: 'Resume goal loop', responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/secrets', tags: ['Conversations'], summary: 'Update conversation secrets', requestBody: updateSecretsRequestSchema, responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/confirmation_policy', tags: ['Conversations'], summary: 'Set confirmation policy', requestBody: setConfirmationPolicyRequestSchema, responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/security_analyzer', tags: ['Conversations'], summary: 'Set security analyzer', requestBody: setSecurityAnalyzerRequestSchema, responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/ask_agent', tags: ['Conversations'], summary: 'Ask agent out of band', requestBody: askAgentRequestSchema, responses: { 200: askAgentResponseSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/condense', tags: ['Conversations'], summary: 'Condense conversation', responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/fork', tags: ['Conversations'], summary: 'Fork conversation', requestBody: forkConversationRequestSchema, responses: { 201: conversationInfoSchema, 404: null, 409: null } },

  { method: 'get', path: '/api/conversations/{conversation_id}/events/search', tags: ['Events'], summary: 'Search conversation events', responses: { 200: openApiEventPageSchema, 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/events/count', tags: ['Events'], summary: 'Count conversation events', responses: { 200: z.number().int().nonnegative(), 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/events', tags: ['Events'], summary: 'Batch get conversation events', responses: { 200: eventBatchSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/events', tags: ['Events'], summary: 'Send a message', requestBody: openApiSendMessageRequestSchema, responses: { 200: successSchema, 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/events/{event_id}', tags: ['Events'], summary: 'Get conversation event', responses: { 200: openApiEventSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/events/respond_to_confirmation', tags: ['Events'], summary: 'Respond to confirmation', requestBody: confirmationResponseRequestSchema, responses: { 200: successSchema, 404: null, 501: null } },
] as const satisfies readonly RouteSpec[];

export interface OpenAPISchema {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly paths: Record<string, Record<string, unknown>>;
}

export function generateOpenApiSchema(): OpenAPISchema {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routeSpecs) {
    const path = paths[route.path] ?? {};
    path[route.method] = operationForRoute(route);
    paths[route.path] = path;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenHands Agent Server',
      version: '0.1.0',
      description: 'OpenHands Agent Server - REST/WebSocket interface for OpenHands AI Agent',
    },
    paths,
  };
}

function operationForRoute(route: RouteSpec): Record<string, unknown> {
  return {
    tags: route.tags,
    summary: route.summary,
    parameters: pathParameters(route.path),
    ...(route.requestBody === undefined ? {} : { requestBody: jsonRequestBody(route.requestBody) }),
    responses: Object.fromEntries(
      Object.entries(route.responses).map(([status, schema]) => [status, responseObject(schema)]),
    ),
  };
}

function pathParameters(path: string): Array<Record<string, unknown>> {
  return [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string', format: match[1]?.endsWith('_id') ? 'uuid' : undefined },
  }));
}

function jsonRequestBody(schema: Schema): Record<string, unknown> {
  return {
    required: true,
    content: {
      'application/json': {
        schema: z.toJSONSchema(schema),
      },
    },
  };
}

function responseObject(schema: Schema | null): Record<string, unknown> {
  if (schema === null) {
    return { description: 'Error' };
  }
  return {
    description: 'Successful Response',
    content: {
      'application/json': {
        schema: z.toJSONSchema(schema),
      },
    },
  };
}
