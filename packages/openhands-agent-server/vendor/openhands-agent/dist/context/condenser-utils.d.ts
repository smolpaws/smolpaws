/** PORT: context/condenser/utils.py. Counts are supplied by the agent's provider boundary. */
import { type LLMConvertibleEvent } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { CondenserContext } from './condenser.js';
export declare function getTotalTokenCount(events: readonly LLMConvertibleEvent[], llm: LLMClient, context?: CondenserContext): Promise<number | null>;
export declare function getShortestPrefixAboveTokenCount(events: readonly LLMConvertibleEvent[], llm: LLMClient, tokenCount: number, baseEvents?: readonly LLMConvertibleEvent[], context?: CondenserContext): Promise<number | null>;
export declare function getSuffixLengthForTokenReduction(events: readonly LLMConvertibleEvent[], llm: LLMClient, tokenReduction: number, baseEvents?: readonly LLMConvertibleEvent[], context?: CondenserContext): Promise<number | null>;
