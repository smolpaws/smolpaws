import { z } from 'zod';
export declare const RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED: readonly ["provider", "model", "openaiApiMode", "baseUrl", "apiVersion", "timeout", "temperature", "topP", "topK", "maxInputTokens", "maxOutputTokens", "reasoningEffort", "reasoningSummary", "promptCacheRetention", "promptCacheKey", "inputCostPerToken", "outputCostPerToken"];
export type RawLlmFieldIgnoredWhenProfileSelected = (typeof RAW_LLM_FIELDS_IGNORED_WHEN_PROFILE_SELECTED)[number];
export type ProfileSelectedLlmSettings = {
    readonly profileId?: string | null;
    readonly encrypted_reasoning?: string | null;
} & {
    readonly [K in RawLlmFieldIgnoredWhenProfileSelected]?: unknown;
};
export declare const AGENT_SETTINGS_SCHEMA_VERSION = 4;
export declare const CONVERSATION_SETTINGS_SCHEMA_VERSION = 1;
export declare const observabilityMetadataSchema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
export declare const observabilityTagsSchema: z.ZodArray<z.ZodString>;
export declare const conversationSettingsSchema: z.ZodObject<{
    schema_version: z.ZodDefault<z.ZodLiteral<number>>;
    max_iterations: z.ZodDefault<z.ZodNumber>;
    observability_metadata: z.ZodDefault<z.ZodNullable<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
    observability_tags: z.ZodDefault<z.ZodNullable<z.ZodArray<z.ZodString>>>;
}, z.core.$strict>;
export declare const openHandsAgentSettingsSchema: z.ZodObject<{
    agent_kind: z.ZodDefault<z.ZodLiteral<"openhands">>;
    llm_profile_ref: z.ZodString;
    agent: z.ZodDefault<z.ZodString>;
    tools: z.ZodDefault<z.ZodArray<z.ZodUnknown>>;
    enable_sub_agents: z.ZodDefault<z.ZodBoolean>;
    enable_switch_llm_tool: z.ZodDefault<z.ZodBoolean>;
    tool_concurrency_limit: z.ZodDefault<z.ZodNumber>;
    condenser: z.ZodDefault<z.ZodUnknown>;
    verification: z.ZodDefault<z.ZodObject<{
        critic_enabled: z.ZodDefault<z.ZodBoolean>;
        critic_mode: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"finish_and_message">, z.ZodLiteral<"all_actions">]>>;
        enable_iterative_refinement: z.ZodDefault<z.ZodBoolean>;
        critic_threshold: z.ZodDefault<z.ZodNumber>;
        max_refinement_iterations: z.ZodDefault<z.ZodNumber>;
        critic_server_url: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        critic_model_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    schema_version: z.ZodDefault<z.ZodLiteral<number>>;
    mcp_config: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>;
export declare const acpAgentSettingsSchema: z.ZodObject<{
    agent_kind: z.ZodDefault<z.ZodLiteral<"acp">>;
    acp_server: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"claude-code">, z.ZodLiteral<"codex">, z.ZodLiteral<"gemini-cli">, z.ZodLiteral<"custom">]>>;
    acp_command: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acp_args: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acp_model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    acp_session_mode: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    acp_prompt_timeout: z.ZodDefault<z.ZodNumber>;
    schema_version: z.ZodDefault<z.ZodLiteral<number>>;
    mcp_config: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>;
export declare const agentSettingsSchema: z.ZodUnion<readonly [z.ZodObject<{
    agent_kind: z.ZodDefault<z.ZodLiteral<"openhands">>;
    llm_profile_ref: z.ZodString;
    agent: z.ZodDefault<z.ZodString>;
    tools: z.ZodDefault<z.ZodArray<z.ZodUnknown>>;
    enable_sub_agents: z.ZodDefault<z.ZodBoolean>;
    enable_switch_llm_tool: z.ZodDefault<z.ZodBoolean>;
    tool_concurrency_limit: z.ZodDefault<z.ZodNumber>;
    condenser: z.ZodDefault<z.ZodUnknown>;
    verification: z.ZodDefault<z.ZodObject<{
        critic_enabled: z.ZodDefault<z.ZodBoolean>;
        critic_mode: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"finish_and_message">, z.ZodLiteral<"all_actions">]>>;
        enable_iterative_refinement: z.ZodDefault<z.ZodBoolean>;
        critic_threshold: z.ZodDefault<z.ZodNumber>;
        max_refinement_iterations: z.ZodDefault<z.ZodNumber>;
        critic_server_url: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        critic_model_name: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    }, z.core.$strip>>;
    schema_version: z.ZodDefault<z.ZodLiteral<number>>;
    mcp_config: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>, z.ZodObject<{
    agent_kind: z.ZodDefault<z.ZodLiteral<"acp">>;
    acp_server: z.ZodDefault<z.ZodUnion<readonly [z.ZodLiteral<"claude-code">, z.ZodLiteral<"codex">, z.ZodLiteral<"gemini-cli">, z.ZodLiteral<"custom">]>>;
    acp_command: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acp_args: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acp_model: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    acp_session_mode: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    acp_prompt_timeout: z.ZodDefault<z.ZodNumber>;
    schema_version: z.ZodDefault<z.ZodLiteral<number>>;
    mcp_config: z.ZodDefault<z.ZodNullable<z.ZodUnknown>>;
}, z.core.$strict>]>;
export type ConversationSettings = z.infer<typeof conversationSettingsSchema>;
export type OpenHandsAgentSettings = z.infer<typeof openHandsAgentSettingsSchema>;
export type ACPAgentSettings = z.infer<typeof acpAgentSettingsSchema>;
export type AgentSettings = OpenHandsAgentSettings | ACPAgentSettings;
export declare function clearRawLlmFieldsWhenProfileSelected<T extends ProfileSelectedLlmSettings>(llm: T): T;
export declare function validateAgentSettings(data: unknown): AgentSettings;
export declare function validateConversationSettings(data: unknown): ConversationSettings;
export declare function defaultAgentSettings(llmProfileRef: string): OpenHandsAgentSettings;
