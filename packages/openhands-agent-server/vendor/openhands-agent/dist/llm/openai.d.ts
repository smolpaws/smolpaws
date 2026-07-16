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
}
export declare class OpenAIChatClient implements LLMClient {
    readonly profile: LLMProfile;
    private readonly apiKey;
    private readonly fetchImpl;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike);
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}
export declare class OpenAIResponsesClient implements LLMClient {
    readonly profile: LLMProfile;
    private readonly apiKey;
    private readonly fetchImpl;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike);
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}
export declare function createOpenAIChatClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<OpenAIChatClient>;
export declare function createOpenAIResponsesClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<OpenAIResponsesClient>;
export declare function buildChatCompletionsBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown>;
export declare function buildOpenAIResponsesBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown>;
