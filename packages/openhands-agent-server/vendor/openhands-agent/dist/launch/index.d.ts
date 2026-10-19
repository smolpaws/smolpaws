import { z } from 'zod';
import { Agent } from '../agent/agent.js';
import { AgentContext, type AgentContextOptions } from '../context/agent-context.js';
import { type LLMProfile } from '../llm/index.js';
import type { LLMClient } from '../llm/client.js';
import { type MetaProfile } from '../meta-profiles/index.js';
import { type AgentProfile, type OpenHandsAgentProfile } from '../profiles/index.js';
import { type OpenHandsAgentSettings } from '../settings/index.js';
import { Skill } from '../skills/index.js';
import { type ToolDefinition, type ToolSpec } from '../tool/index.js';
import '../tool/builtins.js';
export declare class AgentLaunchError extends Error {
    readonly code: string;
    toDetail(): Record<string, unknown>;
}
export declare class ProfileNotFound extends AgentLaunchError {
    readonly code = "agent_profile_not_found";
}
export declare class LaunchStoreError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable?: boolean);
}
export declare class UnresolvedProfileReferences extends AgentLaunchError {
    readonly code = "unresolved_profile_references";
    readonly llmProfileRef: string | null;
    readonly mcpServerRefs: readonly string[];
    readonly metaProfileRef: string | null;
    readonly metaProfileLlmRefs: readonly string[];
    readonly condenserLlmRefs: readonly string[];
    readonly problems: readonly string[];
    constructor(refs?: {
        llmProfileRef?: string | null;
        mcpServerRefs?: readonly string[];
        metaProfileRef?: string | null;
        metaProfileLlmRefs?: readonly string[];
        condenserLlmRefs?: readonly string[];
    });
    toDetail(): Record<string, unknown>;
}
type Awaitable<T> = T | Promise<T>;
export interface LaunchStores {
    readonly llmProfiles: {
        load(name: string): Awaitable<LLMProfile | null>;
    };
    readonly mcpConfig: Readonly<Record<string, unknown>>;
    readonly skills: () => Awaitable<readonly Skill[]>;
    readonly agentProfiles?: {
        nameForId(id: string): Awaitable<string | null>;
        load(name: string): Awaitable<AgentProfile | null>;
    };
    readonly metaProfiles?: {
        load(name: string): Awaitable<MetaProfile | null>;
    };
    readonly llmProfileNames?: () => Awaitable<readonly string[]>;
    /** Explicit native host choice, never an implicit reuse of the main client. */
    readonly defaultCondenserProfileRef?: string;
}
export interface LaunchedAgentProfile {
    readonly agent_profile_id: string;
    readonly revision: number;
    readonly secret_refs: readonly string[] | null;
}
export type LaunchClientRole = 'main' | 'condenser' | 'hard_condenser';
export type LaunchLlmBindings = Readonly<Partial<Record<LaunchClientRole, LLMProfile>>>;
export interface ResolvedLaunchOptions {
    readonly settings: OpenHandsAgentSettings;
    readonly llmProfiles: Readonly<Record<string, LLMProfile>>;
    readonly context?: AgentContextOptions | null;
    /** Durable role snapshots may share a saved profile ID while retaining different historical configurations. */
    readonly bindings?: LaunchLlmBindings;
    readonly profile?: LaunchedAgentProfile | null;
}
/** Immutable data snapshots; no store or credential resolver crosses this boundary. */
export declare class ResolvedLaunch {
    readonly settings: OpenHandsAgentSettings;
    readonly llmProfiles: Readonly<Record<string, LLMProfile>>;
    readonly context: AgentContext | null;
    readonly bindings: LaunchLlmBindings;
    readonly profile: LaunchedAgentProfile | null;
    constructor(options: ResolvedLaunchOptions);
    get allowedSecrets(): ReadonlySet<string> | null;
}
export declare function resolveLaunch(source: AgentProfile | string, stores: LaunchStores): Promise<ResolvedLaunch>;
/** Settings-based callers enter the same snapshot/finalize pipeline as profiles. */
export declare function resolveSettingsLaunch(data: unknown, stores: LaunchStores, context?: AgentContextOptions | null): Promise<ResolvedLaunch>;
export interface LaunchToolContext {
    readonly settings: OpenHandsAgentSettings;
    readonly llm: LLMClient;
    readonly llmProfiles: Readonly<Record<string, LLMProfile>>;
}
export interface LaunchRuntime {
    readonly browserAvailable?: boolean;
    readonly createClient: (profile: LLMProfile, role: LaunchClientRole) => Awaitable<LLMClient>;
    /** Binds selected native tools, MCP and optional routing callbacks; must not call a completion. */
    readonly materializeTools?: (specs: readonly ToolSpec[], context: LaunchToolContext) => Awaitable<readonly ToolDefinition[]>;
    readonly toolContext?: unknown;
    readonly isToolAvailable?: (name: string) => boolean;
    readonly loadMemory?: () => Awaitable<string | null>;
    readonly apiKeyAvailable?: (profile: LLMProfile) => Awaitable<boolean>;
}
export declare const agentLaunchAdditionsSchema: z.ZodObject<{
    system_message_suffix_append: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type AgentLaunchAdditions = z.input<typeof agentLaunchAdditionsSchema>;
export interface FinalizeLaunchOptions {
    readonly additions?: AgentLaunchAdditions | null;
    readonly extraSuffixes?: readonly string[];
    readonly clientTools?: readonly ToolDefinition[];
    readonly loadMemory?: boolean;
    readonly managedSecrets?: readonly string[];
    readonly launchedAt?: Date;
}
export declare class LaunchedAgent {
    readonly agent: Agent;
    readonly profile: LaunchedAgentProfile | null;
    constructor(agent: Agent, profile: LaunchedAgentProfile | null, token?: symbol);
}
export declare function finalizeLaunch(source: ResolvedLaunch | Agent, runtime: LaunchRuntime, options?: FinalizeLaunchOptions): Promise<LaunchedAgent>;
export interface AgentProfileDiagnostics {
    readonly agent_kind: string;
    valid: boolean;
    errors: string[];
    unusable_tools: string[];
    llm_profile_ref: string | null;
    llm_profile_resolved: boolean;
    llm_api_key_set: boolean;
    mcp_server_refs: readonly string[] | null;
    resolved_mcp_config_keys: string[];
    dangling_mcp_server_refs: string[];
    disabled_skills: readonly string[];
    resolved_skills: string[];
    secret_refs: readonly string[] | null;
    meta_profile_ref: string | null;
    dangling_meta_profile_ref: string | null;
    dangling_meta_profile_llm_refs: string[];
    resolved_settings: Record<string, unknown> | null;
}
export declare function previewLaunch(source: OpenHandsAgentProfile | AgentProfile, stores: LaunchStores, runtime: LaunchRuntime, options?: Pick<FinalizeLaunchOptions, 'loadMemory'>): Promise<AgentProfileDiagnostics>;
export type NormalizedLaunchSource = {
    readonly kind: 'agent';
    readonly agent: Agent;
} | {
    readonly kind: 'profile';
    readonly id: string;
} | {
    readonly kind: 'settings';
    readonly settings: unknown;
};
export declare function normalizeLaunchSource(input: {
    readonly agent?: Agent | null;
    readonly agentSettings?: unknown;
    readonly agentProfileId?: string | null;
}): NormalizedLaunchSource;
/** Audited ownership table: adding a setting requires selecting its launch owner. */
export declare const LAUNCH_FIELD_OWNERSHIP: {
    readonly schema_version: "schema";
    readonly agent_kind: "native runtime boundary";
    readonly llm_profile_ref: "LLM profile snapshot";
    readonly agent: "legacy profile label; runtime always native Agent";
    readonly tools: "profile selection/runtime materialization";
    readonly persona: "profile/static prompt";
    readonly mcp_config: "filtered snapshot/host materializer";
    readonly enable_classify_and_switch_llm_tool: "router materialization";
    readonly active_meta_profile: "meta profile reference";
    readonly meta_profile: "router snapshot";
    readonly meta_profile_llms: "router LLM snapshots";
    readonly tool_concurrency_limit: "agent runtime";
    readonly condenser: "condenser snapshot/runtime";
    readonly hard_condenser: "native emergency condenser snapshot/runtime";
    readonly verification: "explicitly rejected until native critic lifecycle exists";
};
export {};
