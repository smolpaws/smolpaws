/** Immutable runtime identity owned by a conversation, never by a shared client. */
export declare class LLMCallContext {
    readonly sessionId: string | null;
    readonly promptCacheKey: string | null;
    constructor(options?: {
        readonly sessionId?: string | null;
        readonly promptCacheKey?: string | null;
    });
    forConversation(id: string, options?: {
        readonly promptCacheKey?: string | null;
    }): LLMCallContext;
    static forConversation(id: string, options?: {
        readonly promptCacheKey?: string | null;
    }): LLMCallContext;
}
/** Explicit empty contexts suppress the scope; null/undefined inherit it. */
export declare function getLLMCallContext(explicit?: LLMCallContext | null): LLMCallContext;
export declare function withLLMCallContext<T>(context: LLMCallContext, operation: () => T): T;
/** Fresh headers, with case-insensitive replacement of stale session identity. */
export declare function applyLLMCallContextHeaders(headers: Readonly<Record<string, string>>, context: LLMCallContext): Readonly<Record<string, string>>;
