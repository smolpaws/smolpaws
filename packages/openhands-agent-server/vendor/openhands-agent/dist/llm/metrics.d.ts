import { z } from 'zod';
import { type Event } from '../event/index.js';
import { type LLMResponseMetadata } from './client.js';
import type { LLMProfile } from './index.js';
export declare const LLM_USAGE_KEY = "llm_usage";
export declare const LLM_METRICS_RESET_KEY = "llm_metrics_reset";
declare const usageRecordSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    record_id: z.ZodString;
    response_id: z.ZodNullable<z.ZodString>;
    usage_id: z.ZodString;
    profile_id: z.ZodString;
    provider_id: z.ZodString;
    model: z.ZodString;
    requested_model: z.ZodString;
    timestamp: z.ZodString;
    latency: z.ZodNumber;
    usage: z.ZodNullable<z.ZodObject<{
        promptTokens: z.ZodOptional<z.ZodNumber>;
        completionTokens: z.ZodOptional<z.ZodNumber>;
        totalTokens: z.ZodOptional<z.ZodNumber>;
        cacheReadTokens: z.ZodOptional<z.ZodNumber>;
        cacheWriteTokens: z.ZodOptional<z.ZodNumber>;
        cacheMissTokens: z.ZodOptional<z.ZodNumber>;
        reasoningTokens: z.ZodOptional<z.ZodNumber>;
        toolUsePromptTokens: z.ZodOptional<z.ZodNumber>;
        providerUsage: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        reportedCost: z.ZodOptional<z.ZodObject<{
            amount: z.ZodNumber;
            currency: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    cost: z.ZodNullable<z.ZodObject<{
        amount: z.ZodNumber;
        currency: z.ZodString;
        source: z.ZodEnum<{
            calculated: "calculated";
            provider: "provider";
        }>;
        pricing: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type UsageRecord = z.infer<typeof usageRecordSchema>;
declare const fields: {
    readonly prompt_tokens: "promptTokens";
    readonly completion_tokens: "completionTokens";
    readonly total_tokens: "totalTokens";
    readonly cache_read_tokens: "cacheReadTokens";
    readonly cache_write_tokens: "cacheWriteTokens";
    readonly cache_miss_tokens: "cacheMissTokens";
    readonly reasoning_tokens: "reasoningTokens";
    readonly tool_use_prompt_tokens: "toolUsePromptTokens";
};
type TokenField = keyof typeof fields;
export type TokenUsage = Record<TokenField, number | null> & {
    model: string;
    response_id: string | null;
    context_window: number | null;
    per_turn_token: number | null;
};
export interface MetricsCoverage {
    completion_count: number;
    missing_usage_count: number;
    missing_cost_count: number;
    missing_fields: Record<TokenField, number>;
    unmeasured_history: boolean;
}
export interface MetricsSnapshot {
    model_name: string;
    accumulated_cost: number | null;
    max_budget_per_task: null;
    accumulated_token_usage: TokenUsage;
    known_token_usage: TokenUsage;
    known_costs: Record<string, number>;
    cost_sources: Record<string, number>;
    cache_hit_rate: number | null;
    coverage: MetricsCoverage;
}
export interface Metrics extends MetricsSnapshot {
    records: UsageRecord[];
    token_usages: TokenUsage[];
    costs: Array<{
        model: string;
        cost: number | null;
        timestamp: number;
        source: string | null;
        currency: string | null;
        response_id: string | null;
        record_id: string;
    }>;
    response_latencies: Array<{
        model: string;
        latency: number;
        response_id: string | null;
        record_id: string;
    }>;
}
export interface ConversationStats {
    usage_to_metrics: Record<string, Metrics>;
    coverage: {
        unmeasured_history: boolean;
        invalid_record_count: number;
        first_recorded_at: string | null;
    };
}
export declare function createLlmUsageEvent(profile: LLMProfile, response: LLMResponseMetadata, timing: {
    startedAt: number;
    completedAt: number;
    usageId?: string;
}): {
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "ConversationStateUpdateEvent";
    key: string;
    value: unknown;
    source?: never;
};
export declare function createMetricsResetEvent(): {
    id: string;
    timestamp: string;
    parent_id: string | null;
    kind: "ConversationStateUpdateEvent";
    key: string;
    value: unknown;
    source?: never;
};
export declare function statsForEvents(events: readonly Event[]): ConversationStats;
export declare function metricsSnapshot(stats: ConversationStats): MetricsSnapshot;
/** Per-usage compact wire updates, matching upstream's key="stats" serializer. */
export declare function statsSnapshot(stats: ConversationStats): {
    usage_to_metrics: {
        [k: string]: MetricsSnapshot;
    };
    coverage: {
        unmeasured_history: boolean;
        invalid_record_count: number;
        first_recorded_at: string | null;
    };
};
export {};
