import type { FetchResponseLike, LLMTokenCountTool } from './client.js';
import type { LLMProfile, Message } from './index.js';
export type MetadataFetchLike = (url: string, init: {
    readonly method: 'GET';
    readonly redirect: 'error';
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
}) => Promise<FetchResponseLike>;
export interface ContextBudgetOptions {
    readonly fetch?: MetadataFetchLike;
    readonly headers?: Readonly<Record<string, string>>;
}
/** Native equivalent of llm.py effective limit and provider-aware metadata cache.
 * A profile value always wins. Discovery is bounded and never occurs in a getter.
 */
export declare class LLMContextBudget {
    private readonly profile;
    private readonly options;
    readonly tokenCountAccuracy: "estimate";
    private resolvedLimit;
    private freshUntil;
    private inflight;
    constructor(profile: LLMProfile, options?: ContextBudgetOptions);
    get effectiveMaxInputTokens(): number | null;
    getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
    resolveRuntimeMetadata(): Promise<void>;
    private resolve;
}
