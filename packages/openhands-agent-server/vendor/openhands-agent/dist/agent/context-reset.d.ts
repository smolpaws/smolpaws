import { type CondenserContext } from '../context/condenser.js';
import type { LLMSummarizingCondenser } from '../context/llm-summarizing-condenser.js';
import type { ConversationState } from '../conversation/state.js';
import { type ActionEvent, type Event } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { ToolDefinition } from '../tool/index.js';
export declare const CONDENSATION_FAILURE_KEY = "condensation_operation_failure";
export type HardCondenser = Pick<LLMSummarizingCondenser, 'hardContextReset'>;
export declare function executeCondenseTool(tool: ToolDefinition, action: ActionEvent, state: ConversationState, inputEventId: string | null, soleCall: boolean): Promise<readonly Event[]>;
/** Resume only a fully durable tool result; never replay tool execution or paid fallback. */
export declare function finishPendingContextReset(state: ConversationState): Promise<readonly Event[] | null>;
export declare function recoverContextWindow(state: ConversationState, history: readonly Event[], inputEventId: string | null, main: LLMClient, hardCondenser: HardCondenser, context: CondenserContext): Promise<readonly Event[]>;
