import { z } from 'zod';
import { type Condenser } from '../context/condenser.js';
import { LLMSummarizingCondenser } from '../context/llm-summarizing-condenser.js';
import type { LLMClient } from '../llm/client.js';
export declare const llmSummarizingCondenserSettingsSchema: z.ZodObject<{
    condenser_kind: z.ZodDefault<z.ZodLiteral<"llm_summarizing">>;
    enabled: z.ZodDefault<z.ZodBoolean>;
    llm_profile_ref: z.ZodOptional<z.ZodString>;
    max_size: z.ZodDefault<z.ZodNumber>;
    max_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    keep_first: z.ZodDefault<z.ZodNumber>;
    minimum_progress: z.ZodDefault<z.ZodNumber>;
    hard_context_reset_max_retries: z.ZodDefault<z.ZodNumber>;
    hard_context_reset_context_scaling: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const noOpCondenserSettingsSchema: z.ZodObject<{
    condenser_kind: z.ZodLiteral<"no_op">;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>;
export declare const agentResetCondenserSettingsSchema: z.ZodObject<{
    condenser_kind: z.ZodLiteral<"agent_reset">;
    enabled: z.ZodDefault<z.ZodBoolean>;
    warning_thresholds: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
}, z.core.$strict>;
/** Full-view error recovery has no ordinary token/event trigger or retained-prefix settings. */
export declare const hardCondenserSettingsSchema: z.ZodObject<{
    condenser_kind: z.ZodLiteral<"llm_summarizing">;
    llm_profile_ref: z.ZodString;
    hard_context_reset_max_retries: z.ZodDefault<z.ZodNumber>;
    hard_context_reset_context_scaling: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export declare const condenserSettingsSchema: z.ZodPreprocess<z.ZodUnion<readonly [z.ZodObject<{
    condenser_kind: z.ZodDefault<z.ZodLiteral<"llm_summarizing">>;
    enabled: z.ZodDefault<z.ZodBoolean>;
    llm_profile_ref: z.ZodOptional<z.ZodString>;
    max_size: z.ZodDefault<z.ZodNumber>;
    max_tokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    keep_first: z.ZodDefault<z.ZodNumber>;
    minimum_progress: z.ZodDefault<z.ZodNumber>;
    hard_context_reset_max_retries: z.ZodDefault<z.ZodNumber>;
    hard_context_reset_context_scaling: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    condenser_kind: z.ZodLiteral<"no_op">;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    condenser_kind: z.ZodLiteral<"agent_reset">;
    enabled: z.ZodDefault<z.ZodBoolean>;
    warning_thresholds: z.ZodDefault<z.ZodArray<z.ZodNumber>>;
}, z.core.$strict>]>>;
export type LLMSummarizingCondenserSettings = z.infer<typeof llmSummarizingCondenserSettingsSchema>;
export type NoOpCondenserSettings = z.infer<typeof noOpCondenserSettingsSchema>;
export type AgentResetCondenserSettings = z.infer<typeof agentResetCondenserSettingsSchema>;
export type HardCondenserSettings = z.infer<typeof hardCondenserSettingsSchema>;
export type CondenserSettings = z.infer<typeof condenserSettingsSchema>;
export interface MaterializeCondenserOptions {
    /** Resolve a saved condenser profile using the host's profile and secret stores. */
    readonly resolveClient: (profileRef: string) => LLMClient | Promise<LLMClient>;
    /** Explicit host selection used only when the saved settings omit a profile. */
    readonly defaultProfileRef?: string;
    /** Used only to inherit the input-token limit, never as the summarizing client. */
    readonly agentLlm?: LLMClient | null;
}
/** Materialize profile-first condenser settings without choosing a store or a main-LLM fallback. */
export declare function materializeCondenser(data: unknown, options: MaterializeCondenserOptions): Promise<Condenser | null>;
/** Materialize the separate emergency fallback; hosts invoke hardContextReset only after an actual provider context error. */
export declare function materializeHardCondenser(data: unknown, options: MaterializeCondenserOptions): Promise<LLMSummarizingCondenser | null>;
