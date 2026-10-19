import { type Event } from '../event/index.js';
import { type Condenser } from '../context/index.js';
import { type HardCondenser } from './context-reset.js';
import type { AgentContext } from '../context/index.js';
import { type LLMClient } from '../llm/client.js';
import { type LLMCallContext } from '../llm/call-context.js';
import type { ToolDefinition } from '../tool/index.js';
import { ConversationState } from '../conversation/state.js';
export declare const CONTENT_POLICY_NUDGE = "Your previous response was blocked by the model's content filter. Please continue, rephrasing to avoid the flagged content.";
export interface AgentOptions {
    readonly llm: LLMClient;
    readonly tools?: readonly ToolDefinition[];
    readonly toolConcurrencyLimit?: number;
    readonly context?: AgentContext | null;
    readonly condenser?: Condenser | null;
    readonly hardCondenser?: HardCondenser | null;
    readonly systemPrompt?: string | null;
    readonly persona?: string | null;
    readonly usageId?: string;
}
export declare class Agent {
    readonly llm: LLMClient;
    readonly tools: readonly ToolDefinition[];
    readonly toolConcurrencyLimit: number;
    readonly context: AgentContext | null;
    readonly condenser: Condenser | null;
    readonly hardCondenser: HardCondenser | null;
    readonly systemPrompt: string | null;
    readonly persona: string | null;
    readonly usageId: string | undefined;
    constructor(options: AgentOptions);
    /**
     * Copy runtime configuration without replacing a custom agent's prototype or
     * instance members. Subclasses owning ECMAScript private slots must override
     * this hook to construct their own copy; those slots cannot be reflected.
     */
    withOverrides(overrides: Partial<AgentOptions>): this;
    step(state: ConversationState, options?: {
        readonly callContext?: LLMCallContext | null;
    }): Promise<readonly Event[]>;
    private stepWithContext;
    private messagesForState;
    private condenserContext;
    get staticSystemMessage(): string;
    get dynamicContext(): string | null;
    private renderSystemPrompt;
    private runTool;
}
