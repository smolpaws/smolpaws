import type { LLMProfile, OpenAiApiMode } from './index.js';
declare const DETECTED_LLM_PROVIDERS: readonly ["anthropic", "gemini", "openai", "openrouter", "litellm_proxy"];
export type DetectedLlmProvider = (typeof DETECTED_LLM_PROVIDERS)[number];
/** Shared config/history normalization; explicit persisted modes retain their identity. */
export declare function resolveOpenAiApiMode(profile: LLMProfile): OpenAiApiMode;
export declare function resolveProviderFromProfile(profile: LLMProfile): DetectedLlmProvider;
export declare function detectProviderFromBaseUrl(baseUrl?: string | null): DetectedLlmProvider;
export {};
