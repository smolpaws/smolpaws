import { type MetadataFetchLike } from './context-budget.js';
import type { LLMTokenCountTool } from './client.js';
import type { SecretStore } from '../secrets/index.js';
import type { ToolDefinition } from '../tool/index.js';
import { type FetchLike, type LLMClient, type LLMCompletionResponse } from './client.js';
import { type LLMProfile, type Message } from './index.js';
export { llmProfileSchema } from './index.js';
export type { LLMProfile } from './index.js';
export interface CreateGeminiClientOptions {
    readonly fetch?: FetchLike;
    readonly metadataFetch?: MetadataFetchLike;
}
export declare class GeminiClient implements LLMClient {
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
export declare function createGeminiClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateGeminiClientOptions): Promise<GeminiClient>;
export declare function buildGeminiInteractionsBody(profile: LLMProfile, messages: readonly Message[], tools?: readonly ToolDefinition[]): Record<string, unknown>;
