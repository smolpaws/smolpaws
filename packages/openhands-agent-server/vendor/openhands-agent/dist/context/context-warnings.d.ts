import { z } from 'zod';
import { type ConversationStateUpdateEvent, type Event, type MessageEvent } from '../event/index.js';
import type { LLMClient } from '../llm/client.js';
import type { CondenserContext } from './condenser.js';
import type { View } from './view.js';
export declare const DEFAULT_CONTEXT_WARNING_THRESHOLDS: readonly number[];
export declare const contextWarningThresholdsSchema: z.ZodArray<z.ZodNumber>;
/** Advisory, target-only state. Only an appended Condensation starts a new warning cycle. */
export declare function contextWarningEvent(history: readonly Event[], view: View, llm: LLMClient, thresholds: readonly number[], context?: CondenserContext): Promise<ConversationStateUpdateEvent | null>;
/** Rebuild the same model-visible message from its single durable warning marker. */
export declare function contextWarningMessage(event: Event): MessageEvent | null;
