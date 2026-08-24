import { type Event } from '../event/index.js';
import { type Condenser } from '../context/index.js';
import type { AgentContext } from '../context/index.js';
import type { LLMClient } from '../llm/client.js';
import type { ToolDefinition } from '../tool/index.js';
import { ConversationState } from '../conversation/state.js';
export declare const CONTENT_POLICY_NUDGE = "Your previous response was blocked by the model's content filter. Please continue, rephrasing to avoid the flagged content.";
export interface AgentOptions {
    readonly llm: LLMClient;
    readonly tools?: readonly ToolDefinition[];
    readonly toolConcurrencyLimit?: number;
    readonly context?: AgentContext | null;
    readonly condenser?: Condenser | null;
    readonly systemPrompt?: string | null;
}
export declare class Agent {
    readonly llm: LLMClient;
    readonly tools: readonly ToolDefinition[];
    readonly toolConcurrencyLimit: number;
    readonly context: AgentContext | null;
    readonly condenser: Condenser | null;
    readonly systemPrompt: string | null;
    constructor(options: AgentOptions);
    step(state: ConversationState): Promise<readonly Event[]>;
    private messagesForState;
    private renderSystemPrompt;
    private runTool;
}
