import { type Event } from '../event/index.js';
import { type FileStore } from '../io/index.js';
import type { Agent } from '../agent/index.js';
import { ConversationState } from './state.js';
import { StuckDetector, type StuckDetectionThresholds } from './stuck-detector.js';
import { type AgentStepBoundary } from './ext/step-boundary.js';
export interface LocalConversationOptions {
    readonly agent: Agent;
    readonly state?: ConversationState;
    readonly maxIterations?: number;
    readonly stuckDetection?: boolean | StuckDetectionThresholds;
    readonly conversationId?: string;
    readonly conversationsDir?: string;
    readonly fileStore?: FileStore;
    /** Runs before the first step and after each fully persisted step, including finish. */
    readonly onStepBoundary?: AgentStepBoundary;
}
export declare class LocalConversation {
    private activeAgent;
    private readonly onStepBoundary;
    private runInProgress;
    private stepTail;
    private stepUserMessageId;
    get agent(): Agent;
    /** Last user event included when an agent step began; later arrivals remain queued. */
    get lastStepUserMessageId(): string | null;
    readonly state: ConversationState;
    readonly maxIterations: number;
    readonly stuckDetector: StuckDetector | null;
    readonly conversationId: string | null;
    constructor(options: LocalConversationOptions);
    sendMessage(text: string): Event;
    sendMessageAsync(text: string): Promise<Event>;
    pause(): void;
    resume(): void;
    run(): Promise<void>;
    /** Force one condensation step after the currently executing step, without resuming a run. */
    condense(): Promise<void>;
    private withStepLock;
    private runOnce;
    /**
     * Nudge once on a repeating action-error streak, otherwise apply isStuck().
     * Returns true when STUCK was set and the run loop should stop.
     */
    private checkStuckOrNudge;
    arun(): Promise<void>;
    private createUserMessageEvent;
    private resetIdleStatusAfterMessage;
}
