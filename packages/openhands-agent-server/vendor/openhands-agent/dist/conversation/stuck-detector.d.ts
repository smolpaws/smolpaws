import type { Event } from '../event/index.js';
export interface StuckDetectionThresholds {
    readonly actionObservation?: number;
    readonly actionError?: number;
    readonly monologue?: number;
    readonly alternatingPattern?: number;
}
/** The minimal state surface StuckDetector reads; trivially satisfied by ConversationState. */
export interface StuckDetectorState {
    readonly events: readonly Event[];
}
export declare class StuckDetector {
    readonly state: StuckDetectorState;
    readonly thresholds: Required<StuckDetectionThresholds>;
    constructor(state: StuckDetectorState, thresholds?: StuckDetectionThresholds);
    isStuck(): boolean;
    private hasRepeatingActionObservation;
    private hasRepeatingActionError;
    private hasMonologue;
}
