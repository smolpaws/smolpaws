import { z } from 'zod';
import { type Event, type LLMConvertibleEvent } from '../event/index.js';
export declare const LLM_REQUEST_BOUNDARY_KEY = "llm_request_boundary";
export declare const llmRequestBoundarySchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    input_event_id: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    response_event_ids: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
/** Persist with the response events, never associate by a provider's reusable response ID. */
export declare function requestBoundaryEvent(inputEventId: string | null, responseEvents: readonly Event[]): Event;
/**
 * Project only retained input events after replaying condensation in durable order.
 * A response precedes users that arrived after its request snapshot. The saved log,
 * public eventsToMessages conversion and unknown legacy causality remain unchanged.
 */
export declare function historyForRequests(view: readonly LLMConvertibleEvent[], history: readonly Event[]): LLMConvertibleEvent[];
/** User input absent from every completed request remains verbatim during recovery. */
export declare function unconsumedUserEventIds(view: readonly LLMConvertibleEvent[], history: readonly Event[]): Set<string>;
/** A successful subsequent main request, not new user input, rearms paid recovery. */
export declare function hasCompletedLlmRequestAfter(history: readonly Event[], eventId: string): boolean;
