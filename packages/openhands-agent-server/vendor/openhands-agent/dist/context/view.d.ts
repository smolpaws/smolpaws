import { type Event, type LLMConvertibleEvent } from '../event/index.js';
import { ManipulationIndices } from './manipulation-indices.js';
export { ManipulationIndices } from './manipulation-indices.js';
export declare class View {
    readonly events: LLMConvertibleEvent[];
    unhandledCondensationRequest: boolean;
    private readonly history;
    private propertyHistory;
    private readonly pendingRequests;
    private readonly abortedRequests;
    private readonly committedResets;
    private initialUnhandledRequest;
    constructor(events?: readonly LLMConvertibleEvent[], unhandledCondensationRequest?: boolean);
    get length(): number;
    get manipulationIndices(): ManipulationIndices;
    enforceProperties(allEvents: readonly Event[]): void;
    appendEvent(event: Event): void;
    static fromEvents(events: readonly Event[]): View;
    private applyCondensation;
    private applyReset;
    private resetToolPair;
    private validateAuthoringBoundary;
    private protectedInput;
    private applyRequestFailure;
}
