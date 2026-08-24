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
    private lastNudgedErrorEventId;
    constructor(state: StuckDetectorState, thresholds?: StuckDetectionThresholds);
    isStuck(): boolean;
    /**
     * Nudge text once a trailing run of one action repeatedly erroring first
     * reaches the threshold. Nudges once per streak: a frozen streak (e.g. an
     * empty/reasoning-only response that adds no new action) keeps the same
     * error event, so it is not re-emitted.
     */
    getActionErrorNudge(): string | null;
    private hasRepeatingActionObservation;
    private hasRepeatingActionError;
    private hasMonologue;
}
