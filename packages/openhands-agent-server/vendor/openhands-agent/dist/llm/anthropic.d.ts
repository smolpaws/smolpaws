import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { type LLMProfile, type Message } from './index.js';
export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';
export interface CreateAnthropicClientOptions {
    readonly fetch?: FetchLike;
}
export declare class AnthropicMessagesClient implements LLMClient {
    readonly profile: LLMProfile;
    private readonly apiKey;
    private readonly fetchImpl;
    constructor(profile: LLMProfile, apiKey: string, fetchImpl?: FetchLike);
    complete(messages: readonly Message[], tools?: readonly ToolDefinition[]): Promise<LLMCompletionResponse>;
}
export declare function createAnthropicClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateAnthropicClientOptions): Promise<AnthropicMessagesClient>;
export declare function buildAnthropicMessagesBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown>;
