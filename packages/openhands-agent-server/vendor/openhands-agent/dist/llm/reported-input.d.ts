import type { Event } from '../event/index.js';
import type { LLMProfile } from './index.js';
/** Latest successful main request in the current reset generation and binding.
 * Undefined: no such request, so a first-request estimate may be used.
 * Null: that response omitted input usage; do not invent a value or reuse an older count.
 */
export declare function latestReportedInputTokens(history: readonly Event[], profile: LLMProfile, usageId?: string): number | null | undefined;
