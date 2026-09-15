import type { LLMProfile } from './index.js';
export interface PriceableUsage {
    readonly promptTokens?: number | null | undefined;
    readonly completionTokens?: number | null | undefined;
    readonly totalTokens?: number | null | undefined;
    readonly cacheReadTokens?: number | null | undefined;
    readonly cacheMissTokens?: number | null | undefined;
    readonly cacheWriteTokens?: number | null | undefined;
    readonly reasoningTokens?: number | null | undefined;
}
export interface UsageCostEstimate {
    readonly amount: number;
    readonly currency: 'USD';
    readonly source: 'calculated';
    readonly pricing: {
        readonly sourceUrl: string;
        readonly checkedAt: string;
        readonly model: string;
        readonly band: 'peak' | 'off_peak';
        readonly rates: {
            readonly cachedInputPerMillion: number;
            readonly uncachedInputPerMillion: number;
            readonly outputPerMillion: number;
        };
    };
}
/**
 * An estimate from a dated public quote, never a claim about the provider's bill.
 * Times are epoch milliseconds bracketing the request. When a request crosses a
 * tariff boundary the provider's cutoff rule is undocumented, so return unknown.
 * Callers must prefer provider-reported cost and retain this quote with estimates.
 * Supply the response's model when available; an unexpected served model must not
 * inherit the requested model's price.
 */
export declare function estimateUsageCost(profile: LLMProfile, usage: PriceableUsage | null, startedAtMs: number, completedAtMs: number, servedModel?: string): UsageCostEstimate | null;
