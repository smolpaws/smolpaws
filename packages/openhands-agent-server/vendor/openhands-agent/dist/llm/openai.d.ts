import { type MetadataFetchLike } from './context-budget.js';
import type { LLMTokenCountTool } from './client.js';
import { OpenAISubscriptionAuth } from './auth/index.js';
import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { type LLMProfile, type Message } from './index.js';
export { llmCompletionResponseSchema, llmUsageSchema } from './client.js';
export type { FetchLike, FetchResponseLike, LLMClient, LLMCompletionResponse, LLMUsage } from './client.js';
export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';
export interface CreateLlmClientOptions {
    readonly fetch?: FetchLike;
    readonly metadataFetch?: MetadataFetchLike;
    readonly subscriptionAuth?: OpenAISubscriptionAuth;
}
export declare class OpenAIChatClient implements LLMClient {
    readonly profile: LLMProfile;
    private readonly apiKey;
    private readonly fetchImpl;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike, metadataFetch?: MetadataFetchLike);
    private readonly contextBudget;
    readonly tokenCountAccuracy: "estimate";
    get effectiveMaxInputTokens(): number | null;
    getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
    resolveRuntimeMetadata(): Promise<void>;
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}
export declare class OpenAIResponsesClient implements LLMClient {
    readonly profile: LLMProfile;
    private readonly apiKey;
    private readonly fetchImpl;
    private readonly subscriptionAuth?;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike, subscriptionAuth?: OpenAISubscriptionAuth | undefined, metadataFetch?: MetadataFetchLike);
    private readonly contextBudget;
    readonly tokenCountAccuracy: "estimate";
    get effectiveMaxInputTokens(): number | null;
    getTokenCount(messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): Promise<number | null>;
    resolveRuntimeMetadata(): Promise<void>;
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}
export declare function createOpenAIChatClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<OpenAIChatClient>;
export declare function createOpenAIResponsesClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<OpenAIResponsesClient>;
export declare function buildChatCompletionsBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown>;
export declare function buildOpenAIResponsesBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown>;
