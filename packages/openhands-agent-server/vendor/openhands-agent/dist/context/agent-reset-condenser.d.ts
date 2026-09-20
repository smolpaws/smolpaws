import type { Condenser } from './condenser.js';
import type { View } from './view.js';
/** Opt-in agent control. Normal preparation never summarizes or clears history. */
export declare class AgentResetCondenser implements Condenser {
    readonly warningThresholds: readonly number[];
    constructor(options?: {
        readonly warningThresholds?: readonly number[];
    });
    condense(view: View): View;
    handlesCondensationRequests(): boolean;
}
/** Host maintenance has no genuine agent-authored tool exchange to retain. */
export declare class AgentControlledCondensationError extends Error {
    constructor();
}
