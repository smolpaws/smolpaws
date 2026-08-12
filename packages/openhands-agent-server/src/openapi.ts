import { z } from 'zod';

import {
  agentResponseResultSchema,
  askAgentRequestSchema,
  askAgentResponseSchema,
  bashEventPageSchema,
  bashEventSchema,
  executeBashRequestSchema,
  conversationInfoSchema,
  conversationPageSchema,
  forkConversationRequestSchema,
  gitChangeSchema,
  gitDiffSchema,
  healthStatusSchema,
  homeResponseSchema,
  serverInfoSchema,
  setConfirmationPolicyRequestSchema,
  setSecurityAnalyzerRequestSchema,
  startGoalRequestSchema,
  subdirectoryPageSchema,
  successSchema,
  sendMessageResponseSchema,
  updateConversationRequestSchema,
  updateSecretsRequestSchema,
  confirmationResponseRequestSchema,
  activateProfileResponseSchema,
  agentProfileDiagnosticsSchema,
  agentProfileListResponseSchema,
  agentProfilePayloadSchema,
  installedSkillResponseSchema,
  installedSkillsListResponseSchema,
  installSkillRequestSchema,
  llmProfilePayloadSchema,
  marketplaceCatalogResponseSchema,
  profileListResponseSchema,
  profileMutationResponseSchema,
  renameProfileRequestSchema,
  secretCreateRequestSchema,
  secretItemResponseSchema,
  secretsListResponseSchema,
  settingsResponseSchema,
  settingsSchemaResponseSchema,
  settingsUpdateRequestSchema,
  skillsRequestSchema,
  skillsResponseSchema,
  syncResponseSchema,
  uninstallSkillResponseSchema,
  updateSkillResponseSchema,
  updateSkillStateRequestSchema,
  updateSkillStateResponseSchema,
} from './models.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

type Schema = z.ZodType<unknown>;

interface QueryParameterSpec {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly required?: boolean;
  readonly description?: string;
}

export interface RouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary: string;
  readonly requestBody?: Schema;
  readonly query?: readonly QueryParameterSpec[];
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
    event_id: z.string().uuid().optional(),
  })
  .strict();
const openApiStartConversationRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    agent: z.unknown().optional(),
    llm_profile_snapshot: llmProfilePayloadSchema.optional(),
    workspace: z.object({ kind: z.string().optional(), working_dir: z.string().optional() }).passthrough().optional(),
    initial_message: openApiSendMessageRequestSchema.optional(),
    persistence_dir: z.string().nullable().default('workspace/conversations'),
    max_iterations: z.number().int().positive().default(500),
    stuck_detection: z.boolean().default(true),
    title: z.string().nullable().optional(),
    tags: z.record(z.string(), z.string()).default({}),
    worktree: z.boolean().default(false),
    secrets: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const openApiEventSchema = z.object({ kind: z.string() }).passthrough();
const openApiEventPageSchema = z.object({ items: z.array(openApiEventSchema), next_page_id: z.string().nullable().default(null) }).strict();
const eventBatchSchema = z.array(openApiEventSchema.nullable());
const acceptedDeviationSchema = z.object({ detail: z.string(), accepted_deviation: z.literal(true), feature: z.string() }).strict();
const bashClearResponseSchema = z.object({ cleared_count: z.number().int().nonnegative() }).strict();


const paginationQuery: readonly QueryParameterSpec[] = [
  { name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 100 }, description: 'Maximum number of items to return.' },
  { name: 'page_id', schema: { type: 'string', nullable: true }, description: 'Opaque pagination cursor.' },
];
const eventSearchQuery: readonly QueryParameterSpec[] = [
  ...paginationQuery,
  { name: 'kind', schema: { type: 'string', nullable: true } },
  { name: 'source', schema: { type: 'string', nullable: true } },
  { name: 'body', schema: { type: 'string', nullable: true } },
  { name: 'sort_order', schema: { type: 'string', enum: ['TIMESTAMP', 'TIMESTAMP_DESC'] } },
  { name: 'timestamp_gte', schema: { type: 'string', format: 'date-time', nullable: true } },
  { name: 'timestamp_lt', schema: { type: 'string', format: 'date-time', nullable: true } },
];
const eventCountQuery: readonly QueryParameterSpec[] = eventSearchQuery.filter((parameter) => parameter.name !== 'limit' && parameter.name !== 'page_id' && parameter.name !== 'sort_order');
const idsQuery: readonly QueryParameterSpec[] = [{ name: 'ids', schema: { type: 'string' }, required: true, description: 'Comma-separated IDs.' }];
const pathQuery: readonly QueryParameterSpec[] = [{ name: 'path', schema: { type: 'string' }, description: 'Filesystem path.' }];


const conversationBatchSchema = z.array(conversationInfoSchema.nullable());

export const routeSpecs = [
  { method: 'get', path: '/', tags: ['Server Details'], summary: 'Server info root', responses: { 200: serverInfoSchema } },
  { method: 'get', path: '/alive', tags: ['Server Details'], summary: 'Liveness check', responses: { 200: healthStatusSchema } },
  { method: 'get', path: '/health', tags: ['Server Details'], summary: 'Health check', responses: { 200: healthStatusSchema } },
  { method: 'get', path: '/ready', tags: ['Server Details'], summary: 'Readiness check', responses: { 200: healthStatusSchema, 503: healthStatusSchema } },
  { method: 'get', path: '/server_info', tags: ['Server Details'], summary: 'Server information', responses: { 200: serverInfoSchema } },

  { method: 'get', path: '/api/conversations/search', tags: ['Conversations'], summary: 'Search conversations', query: paginationQuery, responses: { 200: conversationPageSchema } },
  { method: 'get', path: '/api/conversations/count', tags: ['Conversations'], summary: 'Count conversations', responses: { 200: z.number().int().nonnegative() } },
  { method: 'get', path: '/api/conversations', tags: ['Conversations'], summary: 'Batch get conversations', query: idsQuery, responses: { 200: conversationBatchSchema } },
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
  { method: 'post', path: '/api/conversations/{conversation_id}/secrets', tags: ['Conversations'], summary: 'Update keychain-backed conversation secrets', requestBody: updateSecretsRequestSchema, responses: { 200: successSchema, 400: null, 404: null } },

  { method: 'post', path: '/api/conversations/{conversation_id}/confirmation_policy', tags: ['Conversations'], summary: 'Accepted deviation: confirmation policy is intentionally unsupported', requestBody: setConfirmationPolicyRequestSchema, responses: { 410: acceptedDeviationSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/security_analyzer', tags: ['Conversations'], summary: 'Accepted deviation: security analyzer is intentionally unsupported', requestBody: setSecurityAnalyzerRequestSchema, responses: { 410: acceptedDeviationSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/ask_agent', tags: ['Conversations'], summary: 'Ask agent out of band', requestBody: askAgentRequestSchema, responses: { 200: askAgentResponseSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/condense', tags: ['Conversations'], summary: 'Condense conversation', responses: { 200: successSchema, 404: null, 501: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/fork', tags: ['Conversations'], summary: 'Fork conversation', requestBody: forkConversationRequestSchema, responses: { 201: conversationInfoSchema, 404: null, 409: null } },

  { method: 'get', path: '/api/conversations/{conversation_id}/events/search', tags: ['Events'], summary: 'Search conversation events', query: eventSearchQuery, responses: { 200: openApiEventPageSchema, 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/events/count', tags: ['Events'], summary: 'Count conversation events', query: eventCountQuery, responses: { 200: z.number().int().nonnegative(), 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/events', tags: ['Events'], summary: 'Batch get conversation events', query: idsQuery, responses: { 200: eventBatchSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/events', tags: ['Events'], summary: 'Send a message', requestBody: openApiSendMessageRequestSchema, responses: { 200: sendMessageResponseSchema, 404: null } },
  { method: 'get', path: '/api/conversations/{conversation_id}/events/{event_id}', tags: ['Events'], summary: 'Get conversation event', responses: { 200: openApiEventSchema, 404: null } },
  { method: 'post', path: '/api/conversations/{conversation_id}/events/respond_to_confirmation', tags: ['Events'], summary: 'Accepted deviation: confirmation responses are intentionally unsupported', requestBody: confirmationResponseRequestSchema, responses: { 410: acceptedDeviationSchema, 404: null } },

  { method: 'get', path: '/api/bash/bash_events/search', tags: ['Bash'], summary: 'Search bash events', query: paginationQuery, responses: { 200: bashEventPageSchema } },
  { method: 'get', path: '/api/bash/bash_events/{event_id}', tags: ['Bash'], summary: 'Get bash event', responses: { 200: bashEventSchema, 404: null } },
  { method: 'get', path: '/api/bash/bash_events', tags: ['Bash'], summary: 'Batch get bash events', query: [{ name: 'event_ids', schema: { type: 'string' }, required: true, description: 'Comma-separated event IDs.' }], responses: { 200: z.array(bashEventSchema.nullable()) } },
  { method: 'post', path: '/api/bash/start_bash_command', tags: ['Bash'], summary: 'Start bash command', requestBody: executeBashRequestSchema, responses: { 200: bashEventSchema } },
  { method: 'post', path: '/api/bash/execute_bash_command', tags: ['Bash'], summary: 'Execute bash command', requestBody: executeBashRequestSchema, responses: { 200: bashEventSchema } },
  { method: 'delete', path: '/api/bash/bash_events', tags: ['Bash'], summary: 'Clear bash events', responses: { 200: bashClearResponseSchema } },

  { method: 'get', path: '/api/settings/agent-schema', tags: ['Settings'], summary: 'Get agent settings schema', responses: { 200: settingsSchemaResponseSchema } },
  { method: 'get', path: '/api/settings/conversation-schema', tags: ['Settings'], summary: 'Get conversation settings schema', responses: { 200: settingsSchemaResponseSchema } },
  { method: 'get', path: '/api/settings', tags: ['Settings'], summary: 'Get current settings', responses: { 200: settingsResponseSchema } },
  { method: 'patch', path: '/api/settings', tags: ['Settings'], summary: 'Update settings', requestBody: settingsUpdateRequestSchema, responses: { 200: settingsResponseSchema, 422: null } },
  { method: 'get', path: '/api/settings/secrets', tags: ['Settings'], summary: 'List secret metadata', responses: { 200: secretsListResponseSchema } },
  { method: 'put', path: '/api/settings/secrets', tags: ['Settings'], summary: 'Create or update a keychain-backed secret', requestBody: secretCreateRequestSchema, responses: { 200: secretItemResponseSchema, 422: null } },
  { method: 'get', path: '/api/settings/secrets/{name}', tags: ['Settings'], summary: 'Get redacted secret metadata', responses: { 200: secretItemResponseSchema, 404: null } },
  { method: 'delete', path: '/api/settings/secrets/{name}', tags: ['Settings'], summary: 'Delete a keychain-backed secret', responses: { 200: successSchema, 404: null } },

  { method: 'get', path: '/api/profiles', tags: ['Profiles'], summary: 'List LLM profiles', responses: { 200: profileListResponseSchema } },
  { method: 'get', path: '/api/profiles/{name}', tags: ['Profiles'], summary: 'Get LLM profile', responses: { 200: llmProfilePayloadSchema, 404: null } },
  { method: 'post', path: '/api/profiles', tags: ['Profiles'], summary: 'Create or update LLM profile', requestBody: llmProfilePayloadSchema, responses: { 201: llmProfilePayloadSchema, 422: null } },
  { method: 'post', path: '/api/profiles/{name}', tags: ['Profiles'], summary: 'Create or update LLM profile by name', requestBody: llmProfilePayloadSchema, responses: { 201: llmProfilePayloadSchema, 422: null } },
  { method: 'delete', path: '/api/profiles/{name}', tags: ['Profiles'], summary: 'Delete LLM profile', responses: { 200: profileMutationResponseSchema } },
  { method: 'post', path: '/api/profiles/{name}/rename', tags: ['Profiles'], summary: 'Rename LLM profile', requestBody: renameProfileRequestSchema, responses: { 200: profileMutationResponseSchema, 404: null, 409: null } },
  { method: 'post', path: '/api/profiles/{name}/activate', tags: ['Profiles'], summary: 'Activate LLM profile', responses: { 200: activateProfileResponseSchema, 404: null } },

  { method: 'get', path: '/api/agent-profiles', tags: ['Agent Profiles'], summary: 'List agent profiles', responses: { 200: agentProfileListResponseSchema } },
  { method: 'get', path: '/api/agent-profiles/{name}', tags: ['Agent Profiles'], summary: 'Get agent profile', responses: { 200: agentProfilePayloadSchema, 404: null } },
  { method: 'post', path: '/api/agent-profiles', tags: ['Agent Profiles'], summary: 'Create or update agent profile', requestBody: agentProfilePayloadSchema, responses: { 201: agentProfilePayloadSchema, 422: null } },
  { method: 'post', path: '/api/agent-profiles/{name}', tags: ['Agent Profiles'], summary: 'Create or update agent profile by name', requestBody: agentProfilePayloadSchema, responses: { 201: agentProfilePayloadSchema, 422: null } },
  { method: 'delete', path: '/api/agent-profiles/{name}', tags: ['Agent Profiles'], summary: 'Delete agent profile', responses: { 200: profileMutationResponseSchema } },
  { method: 'post', path: '/api/agent-profiles/{name}/rename', tags: ['Agent Profiles'], summary: 'Rename agent profile', requestBody: renameProfileRequestSchema, responses: { 200: profileMutationResponseSchema, 404: null, 409: null } },
  { method: 'post', path: '/api/agent-profiles/{profile_id}/activate', tags: ['Agent Profiles'], summary: 'Activate agent profile', responses: { 200: activateProfileResponseSchema, 404: null } },
  { method: 'post', path: '/api/agent-profiles/{name}/materialize', tags: ['Agent Profiles'], summary: 'Materialize agent profile diagnostics', responses: { 200: agentProfileDiagnosticsSchema, 404: null } },

  { method: 'post', path: '/api/skills', tags: ['Skills'], summary: 'Load available skills', requestBody: skillsRequestSchema, responses: { 200: skillsResponseSchema } },
  { method: 'post', path: '/api/skills/sync', tags: ['Skills'], summary: 'Sync public skills cache', responses: { 200: syncResponseSchema } },
  { method: 'post', path: '/api/skills/install', tags: ['Skills'], summary: 'Install local skill', requestBody: installSkillRequestSchema, responses: { 201: installedSkillResponseSchema, 400: null, 409: null, 422: null } },
  { method: 'get', path: '/api/skills/installed', tags: ['Skills'], summary: 'List installed skills', responses: { 200: installedSkillsListResponseSchema } },
  { method: 'get', path: '/api/skills/installed/{skill_name}', tags: ['Skills'], summary: 'Get installed skill', responses: { 200: installedSkillResponseSchema, 404: null } },
  { method: 'patch', path: '/api/skills/installed/{skill_name}', tags: ['Skills'], summary: 'Enable or disable installed skill', requestBody: updateSkillStateRequestSchema, responses: { 200: updateSkillStateResponseSchema, 404: null } },
  { method: 'delete', path: '/api/skills/installed/{skill_name}', tags: ['Skills'], summary: 'Uninstall skill', responses: { 200: uninstallSkillResponseSchema, 404: null } },
  { method: 'post', path: '/api/skills/installed/{skill_name}/refresh', tags: ['Skills'], summary: 'Refresh installed skill', responses: { 200: updateSkillResponseSchema, 404: null } },
  { method: 'get', path: '/api/skills/marketplace', tags: ['Skills'], summary: 'Get marketplace catalog', responses: { 200: marketplaceCatalogResponseSchema } },


  { method: 'get', path: '/api/git/changes', tags: ['Git'], summary: 'Get git changes', query: pathQuery, responses: { 200: z.array(gitChangeSchema), 400: null } },
  { method: 'get', path: '/api/git/diff', tags: ['Git'], summary: 'Get git diff', query: pathQuery, responses: { 200: gitDiffSchema, 400: null } },
  { method: 'get', path: '/api/git/changes/{path}', tags: ['Git'], summary: 'Get git changes for path', responses: { 200: z.array(gitChangeSchema), 400: null } },
  { method: 'get', path: '/api/git/diff/{path}', tags: ['Git'], summary: 'Get git diff for path', responses: { 200: gitDiffSchema, 400: null } },

  { method: 'post', path: '/api/file/upload', tags: ['File'], summary: 'Upload file', query: pathQuery, responses: { 200: successSchema, 400: null, 403: null } },
  { method: 'get', path: '/api/file/download', tags: ['File'], summary: 'Download file', query: pathQuery, responses: { 200: z.unknown(), 400: null, 403: null, 404: null } },
  { method: 'post', path: '/api/file/upload/{path}', tags: ['File'], summary: 'Upload file by path', responses: { 200: successSchema, 400: null, 403: null } },
  { method: 'get', path: '/api/file/download/{path}', tags: ['File'], summary: 'Download file by path', responses: { 200: z.unknown(), 400: null, 403: null, 404: null } },
  { method: 'get', path: '/api/file/home', tags: ['File'], summary: 'Get home and favorite directories', responses: { 200: homeResponseSchema } },
  { method: 'get', path: '/api/file/search_subdirs', tags: ['File'], summary: 'Search subdirectories', responses: { 200: subdirectoryPageSchema, 400: null, 403: null, 404: null } },
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
    parameters: [...pathParameters(route.path), ...queryParameters(route.query ?? [])],
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

function queryParameters(query: readonly QueryParameterSpec[]): Array<Record<string, unknown>> {
  return query.map((parameter) => ({
    name: parameter.name,
    in: 'query',
    required: parameter.required ?? false,
    ...(parameter.description === undefined ? {} : { description: parameter.description }),
    schema: parameter.schema,
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
