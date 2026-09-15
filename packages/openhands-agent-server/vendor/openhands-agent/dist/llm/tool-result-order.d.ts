import type { Message } from './index.js';
/**
 * A user can speak while a tool is running. Keep that durable chronology intact,
 * but send completed call/result groups atomically to provider APIs. Only plain
 * user messages may move, and only when every result in this batch is present.
 * Missing/duplicate/unrelated results and later assistant turns are not repaired.
 */
export declare function orderCompletedToolResults(messages: readonly Message[]): Message[];
