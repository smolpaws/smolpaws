/** PORT: pinned summarizing_{system,events}.j2 and event __str__ previews. No event JSON or opaque reasoning is sent. */
import { type LLMConvertibleEvent } from '../event/index.js';
export declare function renderSummarizingSystemPrompt(): string;
export declare function renderSummarizingEventsPrompt(eventStrings: readonly string[]): string;
/** Legacy combined-text helper. Summary requests use separate system/user messages. */
export declare function renderSummarizingPrompt(eventStrings: readonly string[]): string;
export declare function renderCondenserEvent(event: LLMConvertibleEvent): string;
/** Python str slicing counts Unicode code points, including while scaling hard-reset ceilings. */
export declare function truncateCondenserEvent(value: string, limit: number | null): string;
