import type { ConversationState } from '../conversation/state.js';
import { type Event, type LLMConvertibleEvent } from '../event/index.js';
import type { LLMProfile } from './index.js';
export declare const LLM_HISTORY_ORIGIN_KEY = "llm_history_origin";
/** Call under the conversation's step-boundary guard, before committing a replacement binding. */
export declare function ensureLlmHistoryOrigin(state: ConversationState, profile: LLMProfile): Promise<void>;
/** Project copies for the selected LLM. The EventLog remains an unmodified record of each response. */
export declare function historyForProfile(view: readonly LLMConvertibleEvent[], history: readonly Event[], profile: LLMProfile, legacyProfile?: LLMProfile): LLMConvertibleEvent[];
