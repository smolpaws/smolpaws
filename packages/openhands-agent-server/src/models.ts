import { z } from 'zod';

import {
  contentSchema,
  conversationExecutionStatus,
  eventSchema,
  llmProfileSchema,
  messageSchema,
  type Content,
  type ConversationExecutionStatus,
  type Event,
  type Message,
} from '@smolpaws/openhands-agent';

const executionStatuses = Object.values(conversationExecutionStatus) as [ConversationExecutionStatus, ...ConversationExecutionStatus[]];

export const conversationExecutionStatusSchema = z.enum(executionStatuses);

export const successSchema = z.object({ success: z.boolean().default(true) }).strict();
export type Success = z.infer<typeof successSchema>;

export const errorResponseSchema = z.object({ error: z.string() }).strict();
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const conversationSortOrderSchema = z.enum(['CREATED_AT', 'UPDATED_AT', 'CREATED_AT_DESC', 'UPDATED_AT_DESC']);
export type ConversationSortOrder = z.infer<typeof conversationSortOrderSchema>;

export const eventSortOrderSchema = z.enum(['TIMESTAMP', 'TIMESTAMP_DESC']);
export type EventSortOrder = z.infer<typeof eventSortOrderSchema>;

export const workspaceSchema = z
  .object({
    kind: z.string().default('LocalWorkspace'),
    working_dir: z.string().default('workspace/project'),
  })
  .passthrough();
export type WorkspacePayload = z.infer<typeof workspaceSchema>;

export const sendMessageRequestSchema = z
  .object({
    role: z.enum(['user', 'system', 'assistant', 'tool']).default('user'),
    content: z.union([z.string(), z.array(contentSchema)]).transform((content) => (typeof content === 'string' ? [{ type: 'text' as const, text: content, cache_prompt: false }] : content)),
    extended_content: z.array(contentSchema).optional(),
    run: z.boolean().default(true),
    sender: z.string().nullable().optional(),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const startConversationRequestSchema = z
  .object({
    id: z.string().uuid().optional(),
    conversation_id: z.string().uuid().optional(),
    agent: z.unknown().optional(),
    llm_profile_snapshot: llmProfileSchema.optional(),
    workspace: workspaceSchema.default({ kind: 'LocalWorkspace', working_dir: 'workspace/project' }),
    initial_message: sendMessageRequestSchema.optional(),
    persistence_dir: z.string().nullable().default('workspace/conversations'),
    max_iterations: z.number().int().positive().default(500),
    stuck_detection: z.boolean().default(true),
    title: z.string().nullable().optional(),
    tags: z.record(z.string(), z.string()).default({}),
    secrets: z.record(z.string(), z.unknown()).optional(),
    worktree: z.boolean().default(false),
  })
  .passthrough();
export type StartConversationRequest = z.infer<typeof startConversationRequestSchema>;

export const updateConversationRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    tags: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

export const forkConversationRequestSchema = z
  .object({
    id: z.string().uuid().nullable().default(null),
    title: z.string().max(200).nullable().default(null),
    tags: z.record(z.string(), z.string()).nullable().default(null),
    reset_metrics: z.boolean().default(true),
  })
  .strict();
export type ForkConversationRequest = z.infer<typeof forkConversationRequestSchema>;

export const confirmationResponseRequestSchema = z
  .object({
    accept: z.boolean(),
    reason: z.string().default('User rejected the action.'),
  })
  .strict();
export type ConfirmationResponseRequest = z.infer<typeof confirmationResponseRequestSchema>;

export const updateSecretsRequestSchema = z
  .object({
    secrets: z.record(z.string(), z.unknown()),
  })
  .strict();
export type UpdateSecretsRequest = z.infer<typeof updateSecretsRequestSchema>;

export const setConfirmationPolicyRequestSchema = z
  .object({
    policy: z.unknown(),
  })
  .strict();
export type SetConfirmationPolicyRequest = z.infer<typeof setConfirmationPolicyRequestSchema>;

export const setSecurityAnalyzerRequestSchema = z
  .object({
    security_analyzer: z.unknown().nullable(),
  })
  .strict();
export type SetSecurityAnalyzerRequest = z.infer<typeof setSecurityAnalyzerRequestSchema>;

export const askAgentRequestSchema = z.object({ question: z.string() }).strict();
export const askAgentResponseSchema = z.object({ response: z.string() }).strict();
export type AskAgentRequest = z.infer<typeof askAgentRequestSchema>;
export type AskAgentResponse = z.infer<typeof askAgentResponseSchema>;

export const startGoalRequestSchema = z
  .object({
    objective: z.string(),
    max_iterations: z.number().int().positive().default(10),
  })
  .strict();
export type StartGoalRequest = z.infer<typeof startGoalRequestSchema>;

export const agentResponseResultSchema = z.object({ response: z.string() }).strict();
export type AgentResponseResult = z.infer<typeof agentResponseResultSchema>;

export interface StoredConversation {
  readonly id: string;
  readonly request: StartConversationRequest;
  readonly workspace: WorkspacePayload;
  title: string | null;
  tags: Record<string, string>;
  secret_names: readonly string[];
  created_at: string;
  updated_at: string;
}

export const conversationInfoSchema = z
  .object({
    id: z.string().uuid(),
    workspace: workspaceSchema,
    persistence_dir: z.string().nullable().default('workspace/conversations'),
    max_iterations: z.number().int().positive().default(500),
    stuck_detection: z.boolean().default(true),
    execution_status: conversationExecutionStatusSchema,
    confirmation_policy: z.unknown().optional(),
    security_analyzer: z.unknown().nullable().optional(),
    activated_knowledge_skills: z.array(z.string()).default([]),
    invoked_skills: z.array(z.string()).default([]),
    blocked_actions: z.record(z.string(), z.string()).default({}),
    blocked_messages: z.record(z.string(), z.string()).default({}),
    last_user_message_id: z.string().nullable().default(null),
    stats: z.record(z.string(), z.unknown()).default({}),
    secret_registry: z.record(z.string(), z.unknown()).default({}),
    agent_state: z.record(z.string(), z.unknown()).default({}),
    hook_config: z.unknown().nullable().default(null),
    title: z.string().nullable().default(null),
    metrics: z.unknown().nullable().default(null),
    created_at: z.string(),
    updated_at: z.string(),
    tags: z.record(z.string(), z.string()).default({}),
    current_model_id: z.string().nullable().default(null),
    available_models: z.array(z.unknown()).default([]),
    supports_runtime_model_switch: z.boolean().default(false),
    launched_agent_profile: z.unknown().nullable().default(null),
    agent: z.unknown().optional(),
    client_tools: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type ConversationInfo = z.infer<typeof conversationInfoSchema>;

export const conversationPageSchema = z
  .object({
    items: z.array(conversationInfoSchema),
    next_page_id: z.string().nullable().default(null),
  })
  .strict();
export type ConversationPage = z.infer<typeof conversationPageSchema>;

export const eventPageSchema = z
  .object({
    items: z.array(eventSchema),
    next_page_id: z.string().nullable().default(null),
  })
  .strict();
export type EventPage = z.infer<typeof eventPageSchema>;

export const serverErrorEventSchema = z
  .object({
    kind: z.literal('ServerErrorEvent').default('ServerErrorEvent'),
    id: z.string(),
    timestamp: z.string(),
    source: z.literal('environment').default('environment'),
    code: z.string(),
    detail: z.string(),
  })
  .strict();
export type ServerErrorEvent = z.infer<typeof serverErrorEventSchema>;

export const healthStatusSchema = z.object({ status: z.string() }).passthrough();
export const serverInfoSchema = z
  .object({
    status: z.literal('ok').default('ok'),
    uptime: z.number(),
    idle_time: z.number().default(0),
    title: z.string().default('OpenHands Agent Server'),
    version: z.string(),
    sdk_version: z.string().default('unknown'),
    tools_version: z.string().default('unknown'),
    workspace_version: z.string().default('unknown'),
    build_git_sha: z.string().default('unknown'),
    build_git_ref: z.string().default('unknown'),
    python_version: z.string().default('not-applicable'),
    node_version: z.string(),
    usable_tools: z.array(z.string()).default([]),
    runtime_idle_timeout_seconds: z.number().nullable().default(null),
    max_foreground_terminal_timeout_seconds: z.number().nullable().default(null),
    docs: z.string().default('/docs'),
    redoc: z.string().default('/redoc'),
    initialized: z.boolean().default(true),
    web_url: z.string().nullable().default(null),

  })
  .strict();
export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type ServerInfo = z.infer<typeof serverInfoSchema>;

export const executeBashRequestSchema = z
  .object({
    command: z.string(),
    cwd: z.string().nullable().optional(),
    timeout: z.number().int().positive().default(300),
  })
  .strict();
export type ExecuteBashRequest = z.infer<typeof executeBashRequestSchema>;

export const bashCommandSchema = executeBashRequestSchema.extend({
  kind: z.literal('BashCommand').default('BashCommand'),
  id: z.string(),
  timestamp: z.string(),
});
export const bashOutputSchema = z
  .object({
    kind: z.literal('BashOutput').default('BashOutput'),
    id: z.string(),
    timestamp: z.string(),
    command_id: z.string(),
    order: z.number().int().default(0),
    exit_code: z.number().int().nullable().default(null),
    stdout: z.string().nullable().default(null),
    stderr: z.string().nullable().default(null),
  })
  .strict();
export const bashErrorSchema = z
  .object({
    kind: z.literal('BashError').default('BashError'),
    id: z.string(),
    timestamp: z.string(),
    code: z.string(),
    detail: z.string(),
  })
  .strict();
export const bashEventSchema = z.discriminatedUnion('kind', [bashCommandSchema, bashOutputSchema, bashErrorSchema]);
export type BashCommand = z.infer<typeof bashCommandSchema>;
export type BashOutput = z.infer<typeof bashOutputSchema>;
export type BashEvent = z.infer<typeof bashEventSchema>;

export const bashEventPageSchema = z
  .object({
    items: z.array(bashEventSchema),
    next_page_id: z.string().nullable().default(null),
  })
  .strict();
export type BashEventPage = z.infer<typeof bashEventPageSchema>;

export const gitChangeSchema = z
  .object({
    status: z.enum(['ADDED', 'DELETED', 'UPDATED']),
    path: z.string(),
  })
  .strict();
export const gitDiffSchema = z
  .object({
    modified: z.string().nullable(),
    original: z.string().nullable(),
  })
  .strict();
export const gitPathQuerySchema = z.object({ path: z.string(), ref: z.string().optional() }).strict();
export type GitChange = z.infer<typeof gitChangeSchema>;
export type GitDiff = z.infer<typeof gitDiffSchema>;

export const fileBrowserEntrySchema = z.object({ label: z.string(), path: z.string() }).strict();
export const homeResponseSchema = z
  .object({
    home: z.string(),
    favorites: z.array(fileBrowserEntrySchema).default([]),
    locations: z.array(fileBrowserEntrySchema).default([]),
  })
  .strict();
export const subdirectoryEntrySchema = z.object({ name: z.string(), path: z.string() }).strict();
export const subdirectoryPageSchema = z
  .object({
    items: z.array(subdirectoryEntrySchema),
    next_page_id: z.string().nullable().default(null),
  })
  .strict();
export type HomeResponse = z.infer<typeof homeResponseSchema>;
export type SubdirectoryPage = z.infer<typeof subdirectoryPageSchema>;

export function messageFromSendRequest(request: SendMessageRequest): Message {
  return messageSchema.parse({
    role: request.role,
    content: request.content,
  });
}


export const llmProfilePayloadSchema = llmProfileSchema;
export type LlmProfilePayload = z.infer<typeof llmProfilePayloadSchema>;

export const profileListResponseSchema = z.object({ profiles: z.array(llmProfilePayloadSchema), active_profile_id: z.string().nullable().default(null) }).strict();
export type ProfileListResponse = z.infer<typeof profileListResponseSchema>;

export const renameProfileRequestSchema = z.object({ new_name: z.string().min(1).max(128) }).strict();
export type RenameProfileRequest = z.infer<typeof renameProfileRequestSchema>;

export const profileMutationResponseSchema = z.object({ name: z.string(), message: z.string() }).strict();
export type ProfileMutationResponse = z.infer<typeof profileMutationResponseSchema>;

export const activateProfileResponseSchema = z.object({ id: z.string(), message: z.string() }).strict();
export type ActivateProfileResponse = z.infer<typeof activateProfileResponseSchema>;

export const agentSettingsPayloadSchema = z.object({}).catchall(z.unknown());
export const conversationSettingsPayloadSchema = z.object({}).catchall(z.unknown());
export const settingsResponseSchema = z
  .object({
    agent_settings: agentSettingsPayloadSchema,
    conversation_settings: conversationSettingsPayloadSchema,
    llm_api_key_set: z.boolean().default(false),
    active_profile_id: z.string().nullable().default(null),
    active_agent_profile_id: z.string().nullable().default(null),
  })
  .strict();
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const settingsUpdateRequestSchema = z
  .object({
    agent_settings: agentSettingsPayloadSchema.optional(),
    conversation_settings: conversationSettingsPayloadSchema.optional(),
    llm_api_key: z.string().nullable().optional(),
    active_profile_id: z.string().nullable().optional(),
    active_agent_profile_id: z.string().nullable().optional(),
  })
  .passthrough();
export type SettingsUpdateRequest = z.infer<typeof settingsUpdateRequestSchema>;

export const settingsSchemaResponseSchema = z.object({ schema: z.record(z.string(), z.unknown()) }).strict();

export const secretCreateRequestSchema = z.object({ name: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/u), value: z.string() }).strict();
export type SecretCreateRequest = z.infer<typeof secretCreateRequestSchema>;
export const secretItemResponseSchema = z.object({ name: z.string(), created_at: z.string(), updated_at: z.string(), value: z.string().optional() }).strict();
export const secretsListResponseSchema = z.object({ secrets: z.array(secretItemResponseSchema.omit({ value: true })) }).strict();

export const skillInfoSchema = z
  .object({
    name: z.string(),
    type: z.enum(['repo', 'knowledge', 'agentskills']),
    content: z.string(),
    triggers: z.array(z.string()).default([]),
    source: z.string().nullable().default(null),
    description: z.string().nullable().default(null),
    is_agentskills_format: z.boolean().default(false),
    disable_model_invocation: z.boolean().default(false),
  })
  .strict();
export const skillsRequestSchema = z
  .object({
    load_public: z.boolean().default(false),
    load_user: z.boolean().default(true),
    load_project: z.boolean().default(true),
    load_org: z.boolean().default(false),
    project_dir: z.string().nullable().default(null),
    marketplace_path: z.string().nullable().default(null),
    sandbox_config: z.unknown().nullable().default(null),
    org_configs: z.array(z.unknown()).nullable().default(null),
    org_config: z.unknown().nullable().default(null),
  })
  .passthrough();
export type SkillsRequest = z.infer<typeof skillsRequestSchema>;
export const skillsResponseSchema = z.object({ skills: z.array(skillInfoSchema), sources: z.record(z.string(), z.number().int().nonnegative()).default({}) }).strict();
export const syncResponseSchema = z.object({ status: z.enum(['success', 'error']), message: z.string() }).strict();
export const installSkillRequestSchema = z.object({ source: z.string().min(1), ref: z.string().nullable().default(null), repo_path: z.string().nullable().default(null), force: z.boolean().default(false) }).strict();
export type InstallSkillRequest = z.infer<typeof installSkillRequestSchema>;
export const installedSkillResponseSchema = z
  .object({
    name: z.string(),
    version: z.string().default(''),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    source: z.string(),
    resolved_ref: z.string().nullable().default(null),
    repo_path: z.string().nullable().default(null),
    installed_at: z.string(),
    install_path: z.string(),
  })
  .strict();
export const installedSkillsListResponseSchema = z.object({ skills: z.array(installedSkillResponseSchema) }).strict();
export const updateSkillStateRequestSchema = z.object({ enabled: z.boolean() }).strict();
export const updateSkillStateResponseSchema = z.object({ name: z.string(), enabled: z.boolean() }).strict();
export const uninstallSkillResponseSchema = z.object({ message: z.string() }).strict();
export const updateSkillResponseSchema = z.object({ message: z.string(), skill: installedSkillResponseSchema }).strict();
export const marketplaceCatalogResponseSchema = z.object({ skills: z.array(z.unknown()).default([]) }).strict();

export const agentProfilePayloadSchema = z.object({}).catchall(z.unknown());
export const agentProfileListResponseSchema = z.object({ profiles: z.array(agentProfilePayloadSchema), active_agent_profile_id: z.string().nullable().default(null) }).strict();
export const agentProfileDiagnosticsSchema = z.object({ valid: z.boolean(), errors: z.array(z.string()).default([]), resolved_settings: z.record(z.string(), z.unknown()).nullable().default(null) }).strict();

export function textFromContent(content: readonly Content[]): string {
  return content
    .map((item) => (item.type === 'text' ? item.text : `[${item.type}]`))
    .join('\n');
}

export { eventSchema };
export type { Event };
