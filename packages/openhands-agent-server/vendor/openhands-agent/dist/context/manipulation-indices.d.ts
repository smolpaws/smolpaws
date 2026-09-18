import type { LLMConvertibleEvent } from '../event/index.js';
/** Boundaries where events may be inserted, or ranges removed, without splitting an atomic unit. */
export declare class ManipulationIndices extends Set<number> {
    findNext(threshold: number): number;
    static complete(events: readonly LLMConvertibleEvent[]): ManipulationIndices;
}
