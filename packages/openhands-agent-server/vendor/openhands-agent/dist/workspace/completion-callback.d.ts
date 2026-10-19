import { type EnvLike, type HeaderInjector } from '../observability/index.js';
export interface WorkspaceCompletionRegistration {
    registerConversation(conversationId: string): void;
    registerCost(cost: number | null): void;
}
export interface CompletionCallbackRuntime {
    readonly env?: EnvLike;
    readonly fetch?: typeof globalThis.fetch;
    readonly injectHeaders?: HeaderInjector;
}
/** Runtime-only completion callback state; no credentials are persisted or logged. */
export declare class WorkspaceCompletion implements WorkspaceCompletionRegistration {
    private readonly runtime;
    private conversationId;
    private cost;
    private closing;
    constructor(runtime?: CompletionCallbackRuntime);
    registerConversation(conversationId: string): void;
    registerCost(cost: number | null): void;
    get accumulatedCost(): number | null;
    close(error?: unknown): Promise<void>;
    private send;
}
