export type ApiKeyRefreshHook = () => string | null | Promise<string | null>;
export interface LLMRetryOptions {
    /** Total attempts, including the first request. Default: 5 (pinned Python). */
    readonly maxAttempts?: number;
    readonly minWaitMs?: number;
    readonly maxWaitMs?: number;
    readonly multiplierMs?: number;
}
/** Runtime-only hooks: neither callbacks nor credentials belong in a profile. */
export interface LLMRequestOptions {
    readonly apiKeyRefreshHook?: ApiKeyRefreshHook;
    readonly retry?: LLMRetryOptions;
}
/** Retry transport/HTTP failures and owned deadlines, never parsing or terminal SSE failures. */
export declare function requestWithRecovery<T>(apiKey: string, options: LLMRequestOptions, request: (key: string, refreshed: boolean) => Promise<T>, allowAuthRefresh?: boolean): Promise<T>;
/** Replace a rejected credential without mutating caller-owned header defaults. */
export declare function replaceCredentialHeader(headers: Readonly<Record<string, string>>, name: string, value: string): Readonly<Record<string, string>>;
