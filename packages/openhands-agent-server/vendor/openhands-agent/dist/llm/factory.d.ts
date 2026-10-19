import type { SecretStore } from '../secrets/index.js';
import type { LLMClient } from './client.js';
import type { LLMProfile } from './index.js';
import { type CreateLlmClientOptions } from './openai.js';
export { detectProviderFromBaseUrl, resolveProviderFromProfile, type DetectedLlmProvider } from './transport.js';
export declare function createClientFromProfile(profile: LLMProfile, store: SecretStore, options?: CreateLlmClientOptions): Promise<LLMClient>;
