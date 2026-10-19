import type { LLMProfile } from './index.js';
/** Internal marker: a received body/stream failure must not trigger a paid replay. */
export declare class ResponseReadFailure extends Error {
    readonly original: unknown;
    constructor(original: unknown);
}
export interface AttemptDeadline {
    readonly signal: AbortSignal;
    /** Body collection is bounded, but only this attempt's own timeout is retryable. */
    collect<T>(read: () => Promise<T>): Promise<T>;
    /** Each next chunk gets a fresh idle budget; the hard budget remains shared. */
    next<T>(read: () => Promise<T>): Promise<T>;
}
/** Timers cover one attempt, including body reads, never retry backoff. */
export declare function withAttemptDeadline<T>(profile: LLMProfile, work: (deadline: AttemptDeadline) => Promise<T>): Promise<T>;
