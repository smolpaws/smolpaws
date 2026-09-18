/** PORT: context/condenser/llm_summarizing_condenser.py at the shared manifest pin. */
import { type Condensation, type LLMConvertibleEvent } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import { RollingCondenser, type CondenserContext, type CondensationRequirement } from './condenser.js';
import type { View } from './view.js';
export type CondensationReason = 'request' | 'tokens' | 'events';
export interface LLMSummarizingCondenserOptions {
    readonly llm: LLMClient;
    readonly maxSize?: number;
    readonly maxTokens?: number | null;
    readonly keepFirst?: number;
    readonly minimumProgress?: number;
    readonly hardContextResetMaxRetries?: number;
    readonly hardContextResetContextScaling?: number;
}
export declare class LLMSummarizingCondenser extends RollingCondenser {
    readonly llm: LLMClient;
    readonly maxSize: number;
    readonly maxTokens: number | null;
    readonly keepFirst: number;
    readonly minimumProgress: number;
    readonly hardContextResetMaxRetries: number;
    readonly hardContextResetContextScaling: number;
    constructor(options: LLMSummarizingCondenserOptions);
    handlesCondensationRequests(): boolean;
    effectiveMaxTokens(agentLlm?: LLMClient | null): number | null;
    getCondensationReasons(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<Set<CondensationReason>>;
    condensationRequirement(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<CondensationRequirement | null>;
    getForgottenEvents(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<{
        events: readonly LLMConvertibleEvent[];
        summaryOffset: number;
    }>;
    getCondensation(view: View, agentLlm?: LLMClient | null, context?: CondenserContext): Promise<Condensation>;
    generateCondensation(events: readonly LLMConvertibleEvent[], summaryOffset: number, maxEventStringLength?: number | null, context?: CondenserContext): Promise<Condensation>;
    private recordCompletion;
    hardContextReset(view: View, _agentLlm?: LLMClient | null, context?: CondenserContext): Promise<Condensation | null>;
}
/** The upstream standard agent/sub-agent factory is intentionally smaller than class/settings defaults. */
export declare function defaultCondenser(llm: LLMClient): LLMSummarizingCondenser;
