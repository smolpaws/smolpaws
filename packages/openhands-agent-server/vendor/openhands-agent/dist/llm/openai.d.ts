import { type MetadataFetchLike } from './context-budget.js';
import type { LLMCompletionOptions, LLMTokenCountTool } from './client.js';
import { type LLMCallContext } from './call-context.js';
import { type LLMRequestOptions } from './request-recovery.js';
import { OpenAISubscriptionAuth } from './auth/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { type LLMProfile, type Message } from './index.js';
import { type PromptCacheMetadata } from './provider-quirks.js';
export { llmCompletionResponseSchema, llmUsageSchema } from './client.js';
export type { FetchLike, FetchResponseLike, LLMClient, LLMCompletionResponse, LLMUsage } from './client.js';
export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';
export interface CreateLlmClientOptions extends LLMRequestOptions {
    readonly fetch?: FetchLike;
    readonly metadataFetch?: MetadataFetchLike;
    readonly subscriptionAuth?: OpenAISubscriptionAuth;
}
export declare class OpenAIChatClient implements LLMClient {
    private readonly requestOptions;
    readonly profile: LLMProfile;
    private readonly apiKey;
    private readonly fetchImpl;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike, metadataFetch?: MetadataFetchLike, requestOptions?: LLMRequestOptions);
    private readonly contextBudget;
    readonly tokenCountAccuracy: "estimate";
    get effectiveMaxInputTokens(): number | null;
    getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
    resolveRuntimeMetadata(): Promise<void>;
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[], options?: LLMCompletionOptions): Promise<LLMCompletionResponse>;
}
export declare class OpenAIResponsesClient implements LLMClient {
    private readonly apiKey;
    private readonly fetchImpl;
    private readonly subscriptionAuth?;
    private readonly requestOptions;
    readonly profile: LLMProfile;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike, subscriptionAuth?: OpenAISubscriptionAuth | undefined, metadataFetch?: MetadataFetchLike, requestOptions?: LLMRequestOptions);
    private readonly contextBudget;
    readonly tokenCountAccuracy: "estimate";
    get effectiveMaxInputTokens(): number | null;
    getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
    resolveRuntimeMetadata(): Promise<void>;
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[], options?: LLMCompletionOptions): Promise<LLMCompletionResponse>;
}
export declare function createOpenAIChatClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<OpenAIChatClient>;
export declare function createOpenAIResponsesClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<OpenAIResponsesClient>;
export declare function buildChatCompletionsBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[], context?: LLMCallContext, metadata?: PromptCacheMetadata): Record<string, unknown>;
export declare function buildOpenAIResponsesBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[], context?: LLMCallContext, metadata?: PromptCacheMetadata): Record<string, unknown>;
