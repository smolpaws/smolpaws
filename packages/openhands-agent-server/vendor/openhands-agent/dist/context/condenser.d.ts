import type { Condensation, LLMConvertibleEvent } from '../event/index.js';
import type { LLMClient, LLMCompletionResponse } from '../llm/client.js';
import type { LLMProfile, Message } from '../llm/index.js';
import type { ToolDefinition } from '../tool/index.js';
import type { View } from './view.js';
export type CondenserResult = View | Condensation;
export type MaybeCondenserResult = CondenserResult | Promise<CondenserResult>;
export type CondensationRequirement = 'hard' | 'soft';
type MaybePromise<T> = T | Promise<T>;
export interface CondenserCompletionAttempt {
    readonly llm: LLMClient;
    readonly response?: LLMCompletionResponse;
    readonly error?: unknown;
    readonly startedAt: number;
    readonly completedAt: number;
}
/** Explicit per-operation host state; a condenser never owns a conversation or global metrics. */
export interface CondenserContext {
    readonly tools?: readonly ToolDefinition[];
    readonly messagesForEvents?: (events: readonly LLMConvertibleEvent[]) => readonly Message[];
    readonly projectEvents?: (events: readonly LLMConvertibleEvent[], profile: LLMProfile) => readonly LLMConvertibleEvent[];
    readonly onCompletion?: (attempt: CondenserCompletionAttempt) => void | Promise<void>;
}
export declare const condensationRequirement: {
    readonly HARD: "hard";
    readonly SOFT: "soft";
};
export interface Condenser {
    /** Treat the supplied View as read-only. Synchronous condensers retain their synchronous API. */
    condense(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybeCondenserResult;
    handlesCondensationRequests?(): boolean;
}
export declare class NoCondensationAvailableError extends Error {
    name: string;
}
/** Internal marker: persistence failures must never become another provider attempt. */
export declare class CondenserCompletionCallbackError extends Error {
    constructor(cause: unknown);
}
export declare abstract class RollingCondenser implements Condenser {
    abstract condensationRequirement(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybePromise<CondensationRequirement | null>;
    abstract getCondensation(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybePromise<Condensation>;
    hardContextReset(_view: View, _agentLlm?: LLMClient | null, _context?: CondenserContext): MaybePromise<Condensation | null>;
    condense(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybeCondenserResult;
}
export declare class NoOpCondenser implements Condenser {
    condense(view: View): View;
    handlesCondensationRequests(): boolean;
}
export declare class PipelineCondenser implements Condenser {
    readonly condensers: readonly Condenser[];
    constructor(condensers: readonly Condenser[]);
    condense(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): MaybeCondenserResult;
    handlesCondensationRequests(): boolean;
}
export {};
