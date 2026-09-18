import type { LLMTokenCountTool } from './client.js';
import type { Message } from './index.js';
export declare function estimateInputTokens(model: string, messages: readonly Message[], tools?: readonly LLMTokenCountTool[]): number | null;
