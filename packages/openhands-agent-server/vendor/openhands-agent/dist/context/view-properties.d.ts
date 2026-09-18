import type { Event, LLMConvertibleEvent } from '../event/index.js';
import { ManipulationIndices } from './manipulation-indices.js';
export interface ViewProperty {
    enforce(currentEvents: readonly LLMConvertibleEvent[], allEvents: readonly Event[]): Set<string>;
    manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices;
}
export declare class ObservationUniquenessProperty implements ViewProperty {
    enforce(currentEvents: readonly LLMConvertibleEvent[], _allEvents: readonly Event[]): Set<string>;
    manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices;
}
export declare class BatchAtomicityProperty implements ViewProperty {
    enforce(currentEvents: readonly LLMConvertibleEvent[], allEvents: readonly Event[]): Set<string>;
    manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices;
}
export declare class ToolCallMatchingProperty implements ViewProperty {
    enforce(currentEvents: readonly LLMConvertibleEvent[], _allEvents: readonly Event[]): Set<string>;
    manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices;
}
export declare class ToolLoopAtomicityProperty implements ViewProperty {
    enforce(currentEvents: readonly LLMConvertibleEvent[], allEvents: readonly Event[]): Set<string>;
    manipulationIndices(currentEvents: readonly LLMConvertibleEvent[]): ManipulationIndices;
}
export declare const viewProperties: readonly ViewProperty[];
